/**
 * `buildSite` (workers-runtime) — the framework's build orchestrator
 * for hosts that compile + publish from inside a Cloudflare Worker.
 *
 * Mirrors the Node version (`build-site.ts`, exported as
 * `@astroflare/build/node`) but consumes capabilities (`Site`,
 * `Executor`) instead of reaching for the local filesystem and
 * Node's module loader. Designed to be paired with
 * `R2SnapshotSink` from `@astroflare/host-cloudflare` so an
 * agent / DO can pre-render snapshots to R2 without dialing out
 * to a Node side-car.
 *
 * Shape parity with the Node version:
 *   - astro/markdown pages under `/src/pages/`
 *   - dynamic `[slug]` routes are enumerated through the route's
 *     `getStaticPaths()` export (same machinery `createPreviewHandler`
 *     uses) — one snapshot entry emitted per declared params/props
 *     pair, so what renders in preview is what gets published
 *   - yields `SnapshotEntry` one at a time so callers can stream
 *     them straight into a `SnapshotSink.put`
 *   - route keys match `R2SnapshotSink`'s convention: leading /
 *     trailing slashes stripped, `/` → `index.html`
 *   - SHA-256 hex hash via Web Crypto, deterministic across runs
 *   - **closure-walking**: each page is rendered with its full
 *     transitive `.astro`/`.md`/`.mdx` import graph in the bundle, so
 *     pages that import a layout or a shared component render
 *     correctly.
 *
 * Differences from the Node version:
 *   - no `tmpDir` option (no filesystem)
 *   - the executor must supply a runtime modules map
 *     (`createWorkerdExecutor({ runtime })`) so the spawned isolate
 *     resolves `import { render } from "./runtime/index.js"`
 *   - no `node:crypto` / `node:fs` / `node:os` / `node:path` /
 *     `node:url` / `node:module` imports
 */

import { isCompileError } from "@astroflare/compiler";
import type {
	BuildSiteOutput,
	Cache,
	Executor,
	Logger,
	RenderResult,
	Site,
	SnapshotEntry,
	SnapshotError,
	SnapshotErrorDiagnostic,
	SnapshotErrorLocation,
	TaskBundle,
} from "@astroflare/core";
import { buildCodeFrame, sha256Hex, snippetFor } from "@astroflare/core";
import { inlineBundle } from "@astroflare/preview/bundle";
import { type MarkdownOptions, ModuleGraph } from "@astroflare/preview/module-graph";
import {
	DEFAULT_RUNTIME_IMPORT,
	type RenderTaskInput,
	type StaticPathsResult,
	buildClosureRenderTask,
} from "./render-task.js";

export interface WorkersBuildSiteOptions {
	/** Read-only file capability — `WorkspaceSite`, `MemorySite`, etc. */
	site: Site;
	/**
	 * Spawns isolates to compile + render. In production this is
	 * `createWorkerdExecutor({ loader, runtime: runtimeModules })`;
	 * in tests `InProcessExecutor` works.
	 */
	executor: Executor;
	/**
	 * Optional compile cache. The closure walker memoises compiled
	 * `.astro`/`.md`/`.mdx` bytes here, keyed by source content +
	 * compiler config. When absent, every page recompiles every
	 * dependency from scratch — fine for one-shot CI builds, slow for
	 * repeated runs against the same source. Hosts that build often
	 * (Ember's per-snapshot agent loop, for example) should pass a
	 * `SqlCache` or equivalent.
	 */
	cache?: Cache;
	/**
	 * Optional route-prefix mounted under each built page. Defaults
	 * to `""` — pages under `/src/pages/index.astro` become route
	 * `/`. Mirrors the Node version's `prefix` option.
	 */
	prefix?: string;
	/**
	 * Markdown / MDX compilation options. Same shape as
	 * `CreatePreviewHandlerOptions.markdown` — defaults to no
	 * highlighting; opt in with `{ shiki: true }` to enable Shiki's
	 * pure-JS regex engine.
	 */
	markdown?: MarkdownOptions;
	/** Optional structured logger; unused if absent. */
	logger?: Logger;
	/**
	 * When `true`, per-page failures are yielded as `SnapshotError` entries
	 * instead of thrown, and iteration continues to the next page. Default
	 * `false` — same throw-on-first-error semantics existing pipelines (e.g.
	 * `R2SnapshotSink` publish loops) rely on.
	 *
	 * Use this from agent-facing build loops where you want every broken
	 * page surfaced in one pass. `compile` failures skip the whole page;
	 * `getStaticPaths` failures skip the whole dynamic route; `render`
	 * failures are localised to the failing entry. Successful pages still
	 * yield `SnapshotEntry`s — narrow with `"bytes" in out` (or
	 * `out.kind === "error"`) at the consumer.
	 */
	continueOnError?: boolean;
}

/**
 * Walk `Site.glob("/src/pages/**\/*.{astro,md,mdx}")`, compile + render
 * each page through the supplied executor, emit a `SnapshotEntry`. Each
 * page's full import closure (layouts, shared components, content
 * modules) is bundled together so cross-file imports resolve at render
 * time. Yields entries one-at-a-time so callers pipe to a
 * `SnapshotSink` without buffering the whole site in memory.
 *
 * Static and dynamic routes both go through this loop. For a dynamic
 * `[slug]`-style page the route module's `getStaticPaths()` export is
 * invoked once (through the same `bundleKey`'d isolate the renderer
 * uses), and one entry is emitted per declared `{ params, props }`
 * pair. The same machinery `createPreviewHandler` runs at request
 * time, so the snapshot agrees with what preview serves.
 */
export function buildSite(
	opts: WorkersBuildSiteOptions & { continueOnError: true },
): AsyncIterable<BuildSiteOutput>;
export function buildSite(opts: WorkersBuildSiteOptions): AsyncIterable<SnapshotEntry>;
export function buildSite(opts: WorkersBuildSiteOptions): AsyncIterable<BuildSiteOutput> {
	return buildSiteImpl(opts);
}

async function* buildSiteImpl(opts: WorkersBuildSiteOptions): AsyncIterable<BuildSiteOutput> {
	const enc = new TextEncoder();
	const cache = opts.cache ?? createNoopCache();
	const continueOnError = opts.continueOnError === true;
	const moduleGraph = new ModuleGraph(
		{ site: opts.site, cache, logger: opts.logger },
		{
			runtimeImport: DEFAULT_RUNTIME_IMPORT,
			...(opts.markdown ? { markdown: opts.markdown } : {}),
		},
	);

	const pagePatterns = [
		"/src/pages/**/*.astro",
		"/src/pages/**/*.md",
		"/src/pages/**/*.mdx",
	] as const;
	const seen = new Set<string>();
	const pages: string[] = [];
	for (const pattern of pagePatterns) {
		for await (const path of opts.site.glob(pattern)) {
			if (!path.startsWith("/src/pages/")) continue;
			if (seen.has(path)) continue;
			seen.add(path);
			pages.push(path);
		}
	}
	// Stable order so deploy hashes are deterministic.
	pages.sort();

	for (const sourcePath of pages) {
		let closure: Awaited<ReturnType<ModuleGraph["closure"]>>;
		try {
			closure = await compileClosure(moduleGraph, sourcePath, opts.logger);
		} catch (err) {
			if (!continueOnError) throw err;
			yield buildError({
				sourcePath,
				phase: "compile",
				cause: err,
			});
			continue;
		}

		const taskFactory = () => {
			const code = inlineBundle(closure.modules, DEFAULT_RUNTIME_IMPORT);
			return buildClosureRenderTask({ bundleCode: code });
		};

		const localRoute = pageRoute(sourcePath);
		if (localRoute !== null) {
			// Static route — single render with empty params/props.
			const route = prefixRoute(opts.prefix ?? "", localRoute);
			try {
				const html = await renderRoute(
					opts.executor,
					closure.bundleKey,
					taskFactory,
					sourcePath,
					route,
					{},
					{},
					opts.logger,
				);
				const bytes = enc.encode(html);
				const hash = await sha256Hex(bytes);
				yield { route, bytes, contentType: "text/html;charset=utf-8", hash };
			} catch (err) {
				if (!continueOnError) throw err;
				yield buildError({
					sourcePath,
					route,
					phase: "render",
					cause: err,
				});
			}
			continue;
		}

		// Dynamic route — enumerate through getStaticPaths.
		let staticPaths: StaticPathsResult;
		try {
			staticPaths = await fetchStaticPaths(
				opts.executor,
				closure.bundleKey,
				taskFactory,
				sourcePath,
				opts.logger,
			);
		} catch (err) {
			if (!continueOnError) throw err;
			yield buildError({
				sourcePath,
				phase: "getStaticPaths",
				cause: err,
			});
			continue;
		}

		if (staticPaths === null) {
			const message = `buildSite: dynamic route ${sourcePath} has no getStaticPaths export — every \`[param]\` page must export one`;
			if (!continueOnError) throw new Error(message);
			yield {
				kind: "error",
				sourcePath,
				phase: "getStaticPaths",
				message,
			};
			continue;
		}

		for (const entry of staticPaths) {
			const params = stringifyParams(entry.params);
			const localUrl = dynamicRoute(sourcePath, params);
			const route = prefixRoute(opts.prefix ?? "", localUrl);
			try {
				const html = await renderRoute(
					opts.executor,
					closure.bundleKey,
					taskFactory,
					sourcePath,
					route,
					params,
					entry.props ?? {},
					opts.logger,
				);
				const bytes = enc.encode(html);
				const hash = await sha256Hex(bytes);
				yield { route, bytes, contentType: "text/html;charset=utf-8", hash };
			} catch (err) {
				if (!continueOnError) throw err;
				yield buildError({
					sourcePath,
					route,
					params,
					phase: "render",
					cause: err,
				});
				// per-entry render failures are localised — keep iterating
			}
		}
	}
}

/**
 * Construct a `SnapshotError` with as many structured fields populated as
 * the cause allows. Mirrors the Node `build-site.ts` helper of the same
 * name; see that file for the field-by-field rationale.
 *
 *   - `CompileError` → `location`, `snippet`, `codeFrame`, `diagnostics`
 *     (sourced from the compiler's own per-error ranges + the original
 *     `.astro`/`.md`/`.mdx` text the compiler saw).
 *   - any other `Error` with a `.stack` → `stack` is forwarded so render
 *     and getStaticPaths failures bring through a real trace pointing at
 *     the user's code.
 *   - all errors → `detail` carries the original (un-prefixed) message.
 */
function buildError(args: {
	sourcePath: string;
	phase: SnapshotError["phase"];
	cause: unknown;
	route?: string;
	params?: Record<string, string>;
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

	const inner = unwrapWrappedCause(cause);
	const innerMessage = (inner as Error)?.message ?? String(inner);
	out.detail = innerMessage;

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
			out.detail = primary.message;
		}
		out.diagnostics = diagnostics;
	}

	const stack = (inner as { stack?: unknown })?.stack;
	if (typeof stack === "string" && stack.length > 0) {
		out.stack = stack;
	}

	return out;
}

function unwrapWrappedCause(err: unknown): unknown {
	if (err && typeof err === "object" && "cause" in err) {
		const c = (err as { cause?: unknown }).cause;
		if (c) return c;
	}
	return err;
}

/**
 * `/src/pages/index.astro` → `/`; `/src/pages/about.astro` → `/about`;
 * `/src/pages/about.md` → `/about`; `/src/pages/blog/index.astro` → `/blog`.
 * Returns `null` for paths with `[param]` segments — the dynamic-route
 * branch in `buildSite` handles those via `getStaticPaths` enumeration.
 */
function pageRoute(sourcePath: string): string | null {
	const noPrefix = sourcePath.replace(/^\/src\/pages\//, "/");
	const noExt = noPrefix.replace(/\.(astro|mdx|md)$/, "");
	if (/\[[^\]]+\]/.test(noExt)) return null;
	if (noExt === "/index") return "/";
	if (noExt.endsWith("/index")) return noExt.slice(0, -"/index".length);
	return noExt;
}

/**
 * Substitute `[param]` segments in a dynamic page's source path with the
 * matching values from `params`, producing the URL path for that entry.
 *
 *   `/src/pages/posts/[slug].astro` + `{ slug: "hello-world" }`
 *     → `/posts/hello-world`
 *   `/src/pages/[year]/index.astro` + `{ year: "2024" }`
 *     → `/2024`
 *
 * Single-segment params only — `[...rest]` catchall is a router-side
 * follow-up. Throws if any `[param]` segment isn't present in `params`,
 * since `getStaticPaths` is contract-bound to declare every dynamic
 * segment.
 */
function dynamicRoute(sourcePath: string, params: Record<string, string>): string {
	const noPrefix = sourcePath.replace(/^\/src\/pages\//, "/");
	const noExt = noPrefix.replace(/\.(astro|mdx|md)$/, "");
	const substituted = noExt.replace(/\[([A-Za-z_$][\w$]*)\]/g, (_match, name: string) => {
		const value = params[name];
		if (value === undefined) {
			throw new Error(
				`buildSite: getStaticPaths entry for ${sourcePath} is missing param "${name}" (declared in the file path)`,
			);
		}
		return encodeURIComponent(value);
	});
	if (substituted === "/index") return "/";
	if (substituted.endsWith("/index")) return substituted.slice(0, -"/index".length);
	return substituted;
}

function prefixRoute(prefix: string, route: string): string {
	if (!prefix) return route;
	const cleaned = prefix.replace(/^\/+|\/+$/g, "");
	if (route === "/") return `/${cleaned}/`;
	return `/${cleaned}${route}`;
}

/**
 * `getStaticPaths` may return non-string values (e.g. numeric IDs).
 * Stringify them up front so the URL substitution and downstream
 * `Astro.params` consumers see consistent types — same coercion the
 * preview handler does at request time (`preview-handler.ts`'s
 * `paramsMatch`).
 */
function stringifyParams(params: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(params)) out[k] = String(v);
	return out;
}

async function compileClosure(
	moduleGraph: ModuleGraph,
	sourcePath: string,
	logger: Logger | undefined,
): Promise<Awaited<ReturnType<ModuleGraph["closure"]>>> {
	try {
		return await moduleGraph.closure(sourcePath);
	} catch (err) {
		logger?.event("buildSite.compile.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		throw wrapBuildPhaseError(`buildSite: compile failed for ${sourcePath}`, err);
	}
}

async function fetchStaticPaths(
	executor: Executor,
	bundleKey: string,
	taskFactory: () => TaskBundle,
	sourcePath: string,
	logger: Logger | undefined,
): Promise<StaticPathsResult> {
	try {
		return await executor.runCached<StaticPathsResult>(bundleKey, taskFactory, { kind: "paths" });
	} catch (err) {
		logger?.event("buildSite.static-paths.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		throw wrapBuildPhaseError(`buildSite: getStaticPaths failed for ${sourcePath}`, err);
	}
}

async function renderRoute(
	executor: Executor,
	bundleKey: string,
	taskFactory: () => TaskBundle,
	sourcePath: string,
	route: string,
	params: Record<string, string>,
	props: Record<string, unknown>,
	logger: Logger | undefined,
): Promise<string> {
	const input: RenderTaskInput = {
		url: `http://stack.local${route}`,
		method: "GET",
		props,
		params,
	};

	let result: RenderResult;
	try {
		result = await executor.runCached<RenderResult>(bundleKey, taskFactory, input);
	} catch (err) {
		logger?.event("buildSite.render.failed", {
			path: sourcePath,
			route,
			message: (err as Error).message,
		});
		throw wrapBuildPhaseError(`buildSite: render failed for ${sourcePath}`, err);
	}

	if (result.kind === "html") return result.html;
	throw new Error(`buildSite: ${sourcePath} returned non-HTML render result (kind=${result.kind})`);
}

/**
 * Wrap the underlying error in a phase-prefixed `Error` while preserving
 * the original under `.cause` so downstream error reporting can still see
 * the structured `CompileError` (or runtime stack). Same shape the Node
 * `build-site` uses (`prefixCompileMessage` / `prefixRenderMessage`).
 */
function wrapBuildPhaseError(prefix: string, cause: unknown): Error {
	const message = (cause as Error)?.message ?? String(cause);
	const wrapped = new Error(`${prefix}: ${message}`);
	(wrapped as Error & { cause?: unknown }).cause = cause;
	return wrapped;
}

function createNoopCache(): Cache {
	return {
		async get(): Promise<Uint8Array | null> {
			return null;
		},
		async put(): Promise<void> {
			/* no-op */
		},
	};
}
