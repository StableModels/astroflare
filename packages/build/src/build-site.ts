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
import { CompileError, isCompileError } from "@astroflare/compiler";
import type {
	BuildSiteOutput,
	Site,
	SnapshotEntry,
	SnapshotError,
	SnapshotErrorDiagnostic,
	SnapshotErrorLocation,
	SnapshotSink,
} from "@astroflare/core";
import { buildCodeFrame, snippetFor } from "@astroflare/core";

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
					sourceText,
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
					sourceText,
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

/**
 * Construct a `SnapshotError` with as many structured fields populated as
 * the cause + (optional) sourceText allow:
 *
 *   - `CompileError` (or our compile-error duck-type after a `prefix*`
 *     wrap) → `location`, `snippet`, `codeFrame`, plus a full `diagnostics`
 *     array for the compiler's other findings.
 *   - any other `Error` with a `.stack` → `stack` is forwarded so render /
 *     getStaticPaths failures bring the user a real trace.
 *   - all errors → `detail` carries the original (unprefixed) message so
 *     consumers can format their own headlines.
 */
function buildError(args: {
	sourcePath: string;
	phase: SnapshotError["phase"];
	cause: unknown;
	route?: string;
	params?: Record<string, string>;
	sourceText?: string;
}): SnapshotError {
	const cause = args.cause;
	const wrappedMessage = (cause as Error)?.message ?? String(cause);
	const out: SnapshotError = {
		kind: "error",
		sourcePath: args.sourcePath,
		phase: args.phase,
		message: wrappedMessage,
		cause,
	};
	if (args.route !== undefined) out.route = args.route;
	if (args.params !== undefined) out.params = args.params;

	// Unwrap the framework's `buildSite: <phase> failed for <path>: <inner>`
	// shape so `detail` is the parser/runtime's own message and the
	// CompileError underneath is reachable via `.cause`.
	const inner = unwrapWrappedCause(cause);
	const innerMessage = (inner as Error)?.message ?? String(inner);
	if (innerMessage && innerMessage !== wrappedMessage) {
		out.detail = innerMessage;
	} else {
		out.detail = innerMessage;
	}

	if (isCompileError(inner)) {
		const source = inner.source;
		const diagnostics: SnapshotErrorDiagnostic[] = inner.diagnostics.map((d) => {
			const location: SnapshotErrorLocation = {
				line: d.start.line,
				column: d.start.column,
				offset: d.start.offset,
				...(d.end ? { end: { line: d.end.line, column: d.end.column, offset: d.end.offset } } : {}),
			};
			const diag: SnapshotErrorDiagnostic = { message: d.message, location };
			const snippet = snippetFor(source, location);
			if (snippet) diag.snippet = snippet;
			const frame = buildCodeFrame(source, location);
			if (frame) diag.codeFrame = frame;
			return diag;
		});
		const primary = diagnostics[0];
		if (primary) {
			out.location = primary.location;
			if (primary.snippet) out.snippet = primary.snippet;
			if (primary.codeFrame) out.codeFrame = primary.codeFrame;
			// The first diagnostic's message is the "real" cause; the
			// CompileError's outer message is the prefixed shape.
			out.detail = primary.message;
		}
		out.diagnostics = diagnostics;
	} else if (args.sourceText && (inner as { pos?: unknown })?.pos !== undefined) {
		// Acorn-style errors carry `.pos` (offset) but no `.start`. Cheap
		// upgrade: synthesise a location from the offset and build a
		// frame off the read-side source text.
		const pos = (inner as { pos: number }).pos;
		if (typeof pos === "number" && pos >= 0 && pos <= args.sourceText.length) {
			const location = locateInSource(args.sourceText, pos);
			out.location = location;
			const frame = buildCodeFrame(args.sourceText, location);
			if (frame) out.codeFrame = frame;
		}
	}

	const stack = (inner as { stack?: unknown })?.stack;
	if (typeof stack === "string" && stack.length > 0) {
		out.stack = stack;
	}

	return out;
}

function locateInSource(source: string, offset: number): SnapshotErrorLocation {
	let line = 1;
	let column = 1;
	const max = Math.min(offset, source.length);
	for (let i = 0; i < max; i++) {
		if (source.charCodeAt(i) === 10 /* \n */) {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	return { offset, line, column };
}

/** Strip the framework's outer prefix wrapper to get at the original error. */
function unwrapWrappedCause(err: unknown): unknown {
	if (err && typeof err === "object" && "cause" in err) {
		const c = (err as { cause?: unknown }).cause;
		if (c) return c;
	}
	return err;
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
		// Same shape `module-graph` uses for the workers-runtime path —
		// surfaced as a clean compile error rather than letting the
		// recovered code crash at render time with an opaque message.
		// `CompileError` carries the source text + every diagnostic so
		// `buildError()` can stamp `location`/`snippet`/`codeFrame` onto
		// the SnapshotError downstream.
		throw new CompileError({
			filename: sourcePath,
			source,
			diagnostics: compiled.errors,
		});
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
