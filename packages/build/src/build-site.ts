/**
 * `buildSite` / `deploySite` — Phase 26b's framework-side build
 * primitives. Take a `Site` capability + framework configuration,
 * produce a stream of `SnapshotEntry`s. `deploySite` pipes the
 * stream through a `SnapshotSink` and commits.
 *
 * Pure functions of source → output. No filesystem, no R2, no
 * worker entrypoint — those are host concerns. Tests use
 * `MemorySite` + `MemorySnapshots`; the CLI uses `LocalSite` +
 * a REST-backed `SnapshotSink`; an in-Worker host uses a
 * `WorkspaceSite` + `R2SnapshotSink`.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import type { Site, SnapshotEntry, SnapshotSink } from "@astroflare/core";

const require_ = createRequire(import.meta.url);

export interface BuildSiteOptions {
	site: Site;
	/**
	 * Optional route-prefix mounted under each built page. Defaults to
	 * `""` — pages under `/src/pages/index.astro` become route `/`.
	 * Set e.g. `prefix: "minimal"` to make them `/minimal/`.
	 */
	prefix?: string;
	/**
	 * Where the build's compiled JS modules land before dynamic-import.
	 * Defaults to a fresh tmpdir created per build call.
	 */
	tmpDir?: string;
}

/**
 * Walk `Site.glob("/src/pages/**\/*.astro")`, compile + render each
 * page, emit a `SnapshotEntry`. Yields entries one-at-a-time so
 * callers can pipe to a `SnapshotSink` without buffering the whole
 * site in memory.
 *
 * Static-only for Phase 26b. Dynamic routes (`[slug].astro`) require
 * `getStaticPaths` enumeration — not yet supported here.
 */
export async function* buildSite(opts: BuildSiteOptions): AsyncIterable<SnapshotEntry> {
	const tmpDir = opts.tmpDir ?? (await mkdtemp(join(tmpdir(), "aflare-build-")));
	const created = !opts.tmpDir;
	try {
		const enc = new TextEncoder();
		const pagesGlob = "/src/pages/**/*.astro";
		const pages: string[] = [];
		for await (const path of opts.site.glob(pagesGlob)) {
			if (path.startsWith("/src/pages/") && path.endsWith(".astro")) {
				pages.push(path);
			}
		}
		// Stable order so deploy hashes are deterministic.
		pages.sort();

		for (const sourcePath of pages) {
			const localRoute = pageRoute(sourcePath);
			if (localRoute === null) {
				throw new Error(
					`buildSite: dynamic routes (${sourcePath}) need getStaticPaths to enumerate; not yet supported`,
				);
			}
			const route = prefixRoute(opts.prefix ?? "", localRoute);
			const sourceBytes = await opts.site.readFile(sourcePath);
			if (!sourceBytes) {
				throw new Error(`buildSite: missing source bytes for ${sourcePath}`);
			}
			const html = await compileAndRender(
				sourcePath,
				new TextDecoder().decode(sourceBytes),
				route,
				tmpDir,
			);
			const bytes = enc.encode(html);
			const hash = createHash("sha256").update(bytes).digest("hex");
			yield {
				route,
				bytes,
				contentType: "text/html;charset=utf-8",
				hash,
			};
		}
	} finally {
		if (created) await rm(tmpDir, { recursive: true, force: true });
	}
}

export interface DeploySiteOptions extends BuildSiteOptions {
	sink: SnapshotSink;
}

export interface DeploySiteResult {
	snapshotHash: string;
	routes: readonly string[];
}

/**
 * Convenience composition: drives `buildSite` into the supplied
 * sink and commits with a content-addressed snapshot hash.
 *
 * The snapshot hash is the SHA-256 (truncated to 16 hex chars) of
 * the sorted `(route, contentHash)` pairs — same source → same
 * hash, so two no-op deploys produce identical commits.
 */
export async function deploySite(opts: DeploySiteOptions): Promise<DeploySiteResult> {
	const collected: SnapshotEntry[] = [];
	for await (const entry of buildSite(opts)) {
		collected.push(entry);
	}
	collected.sort((a, b) => a.route.localeCompare(b.route));
	const fingerprint = collected.map((e) => `${e.route}\0${e.hash}`).join("\n");
	const snapshotHash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);

	try {
		for (const entry of collected) {
			await opts.sink.put(snapshotHash, entry);
		}
		await opts.sink.commit(snapshotHash);
	} catch (err) {
		await opts.sink.abort(snapshotHash).catch(() => {});
		throw err;
	}

	return {
		snapshotHash,
		routes: collected.map((e) => e.route),
	};
}

/** `/src/pages/index.astro` → `/`; `/src/pages/about.astro` → `/about`. */
function pageRoute(sourcePath: string): string | null {
	const noPrefix = sourcePath.replace(/^\/src\/pages\//, "/");
	const noExt = noPrefix.replace(/\.astro$/, "");
	if (/\[[^\]]+\]/.test(noExt)) return null;
	if (noExt === "/index") return "/";
	if (noExt.endsWith("/index")) return noExt.slice(0, -"/index".length);
	return noExt;
}

function prefixRoute(prefix: string, route: string): string {
	if (!prefix) return route;
	const cleaned = prefix.replace(/^\/+|\/+$/g, "");
	if (route === "/") return `/${cleaned}/`;
	return `/${cleaned}${route}`;
}

async function compileAndRender(
	sourcePath: string,
	source: string,
	route: string,
	tmpDir: string,
): Promise<string> {
	const { compileAstro } = await import("@astroflare/compiler/astro");
	const { render } = await import("@astroflare/runtime");

	// The compiled module imports framework runtime symbols from
	// `runtimeImport`; point that at the absolute file:// URL of the
	// runtime's built `internal.js` so Node can resolve the import
	// from the tmp dir we write the compiled code to.
	const runtimeImport = pathToFileURL(require_.resolve("@astroflare/runtime/internal")).href;
	const compiled = await compileAstro(source, {
		filename: sourcePath,
		runtimeImport,
	});
	const moduleName = `aflare-${createHash("sha256")
		.update(source + route)
		.digest("hex")
		.slice(0, 16)}.mjs`;
	const modulePath = join(tmpDir, moduleName);
	await mkdir(dirname(modulePath), { recursive: true });
	await writeFile(modulePath, compiled.code, "utf8");
	const moduleUrl = pathToFileURL(modulePath).href;
	const mod = (await import(/* @vite-ignore */ moduleUrl)) as { default: unknown };

	const result = await render(mod.default as never, {
		props: {},
		params: {},
		request: new Request(`http://stack.local${route}`),
		url: new URL(`http://stack.local${route}`),
	});
	if (result.kind === "html") return result.html;
	throw new Error(
		`buildSite: ${posix.basename(sourcePath)} returned non-HTML render result (kind=${result.kind})`,
	);
}

// Keep readFile import used (silences linter when only `await readFile` is removed).
export const __unused_readFile = readFile;
