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
import type {
	BuildSiteOutput,
	Site,
	SnapshotEntry,
	SnapshotError,
	SnapshotSink,
} from "@astroflare/core";

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
	/**
	 * When `true`, per-page failures are yielded as `SnapshotError` entries
	 * instead of thrown, and iteration continues to the next page. Default
	 * `false` — same throw-on-first-error semantics existing pipelines
	 * (e.g. `deploySite`) rely on.
	 *
	 * Mirrors the workers-runtime entry's flag — see
	 * `WorkersBuildSiteOptions.continueOnError`.
	 */
	continueOnError?: boolean;
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
export function buildSite(
	opts: BuildSiteOptions & { continueOnError: true },
): AsyncIterable<BuildSiteOutput>;
export function buildSite(opts: BuildSiteOptions): AsyncIterable<SnapshotEntry>;
export function buildSite(opts: BuildSiteOptions): AsyncIterable<BuildSiteOutput> {
	return buildSiteImpl(opts);
}

async function* buildSiteImpl(opts: BuildSiteOptions): AsyncIterable<BuildSiteOutput> {
	const tmpDir = opts.tmpDir ?? (await mkdtemp(join(tmpdir(), "aflare-build-")));
	const created = !opts.tmpDir;
	const continueOnError = opts.continueOnError === true;
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
				const message = `buildSite: dynamic routes (${sourcePath}) need getStaticPaths to enumerate; not yet supported`;
				if (!continueOnError) throw new Error(message);
				yield {
					kind: "error",
					sourcePath,
					phase: "getStaticPaths",
					message,
				};
				continue;
			}
			const route = prefixRoute(opts.prefix ?? "", localRoute);

			let sourceText: string;
			try {
				const sourceBytes = await opts.site.readFile(sourcePath);
				if (!sourceBytes) {
					throw new Error(`buildSite: missing source bytes for ${sourcePath}`);
				}
				sourceText = new TextDecoder().decode(sourceBytes);
			} catch (err) {
				if (!continueOnError) throw err;
				yield buildError({ sourcePath, phase: "compile", cause: err });
				continue;
			}

			let compiledModulePath: string;
			try {
				compiledModulePath = await compilePage(sourcePath, sourceText, route, tmpDir);
			} catch (err) {
				const wrapped = prefixCompileMessage(sourcePath, err);
				if (!continueOnError) throw wrapped;
				yield buildError({
					sourcePath,
					phase: "compile",
					cause: wrapped,
				});
				continue;
			}

			let html: string;
			try {
				html = await renderCompiled(sourcePath, compiledModulePath, route);
			} catch (err) {
				const wrapped = prefixRenderMessage(sourcePath, err);
				if (!continueOnError) throw wrapped;
				yield buildError({
					sourcePath,
					route,
					phase: "render",
					cause: wrapped,
				});
				continue;
			}

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

function buildError(args: {
	sourcePath: string;
	phase: SnapshotError["phase"];
	cause: unknown;
	route?: string;
	params?: Record<string, string>;
}): SnapshotError {
	const out: SnapshotError = {
		kind: "error",
		sourcePath: args.sourcePath,
		phase: args.phase,
		message: (args.cause as Error)?.message ?? String(args.cause),
		cause: args.cause,
	};
	if (args.route !== undefined) out.route = args.route;
	if (args.params !== undefined) out.params = args.params;
	return out;
}

function prefixCompileMessage(sourcePath: string, err: unknown): Error {
	const message = (err as Error)?.message ?? String(err);
	const wrapped = new Error(`buildSite: compile failed for ${sourcePath}: ${message}`);
	(wrapped as Error & { cause?: unknown }).cause = err;
	return wrapped;
}

function prefixRenderMessage(sourcePath: string, err: unknown): Error {
	const message = (err as Error)?.message ?? String(err);
	const wrapped = new Error(`buildSite: render failed for ${sourcePath}: ${message}`);
	(wrapped as Error & { cause?: unknown }).cause = err;
	return wrapped;
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
	// Force throw-on-first-error: a partial snapshot must never get committed.
	const buildOpts: BuildSiteOptions = { ...opts, continueOnError: false };
	for await (const entry of buildSite(buildOpts)) {
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

async function compilePage(
	sourcePath: string,
	source: string,
	route: string,
	tmpDir: string,
): Promise<string> {
	const { compileAstro } = await import("@astroflare/compiler/astro");

	// The compiled module imports framework runtime symbols from
	// `runtimeImport`; point that at the absolute file:// URL of the
	// runtime's built `internal.js` so Node can resolve the import
	// from the tmp dir we write the compiled code to.
	const runtimeImport = pathToFileURL(require_.resolve("@astroflare/runtime/internal")).href;
	const compiled = await compileAstro(source, {
		filename: sourcePath,
		runtimeImport,
	});
	if (compiled.errors.length > 0) {
		const first = compiled.errors[0];
		// Same shape `module-graph` uses for the workers-runtime path —
		// surfaced as a clean compile error rather than letting the
		// recovered code crash at render time with an opaque message.
		throw new Error(
			`compile error in ${sourcePath} at ${first?.start.line}:${first?.start.column}: ${first?.message}`,
		);
	}
	const moduleName = `aflare-${createHash("sha256")
		.update(source + route)
		.digest("hex")
		.slice(0, 16)}.mjs`;
	const modulePath = join(tmpDir, moduleName);
	await mkdir(dirname(modulePath), { recursive: true });
	await writeFile(modulePath, compiled.code, "utf8");
	return modulePath;
}

async function renderCompiled(
	sourcePath: string,
	modulePath: string,
	route: string,
): Promise<string> {
	const { render } = await import("@astroflare/runtime");
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
