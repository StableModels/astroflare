/**
 * `buildRenderTask` — shared helper that wraps already-compiled `.astro`
 * route code into a `TaskBundle` the framework's `Executor` can run.
 *
 * Used by both `createPreviewHandler` (Mode A, host-cloudflare) and
 * the workers-runtime `buildSite` (Mode B, this package). Keeping the
 * shim shape in one place ensures the two render paths stay in lock-
 * step — same module names, same input shape, same expected
 * `RenderResult` output.
 *
 * The shim:
 *   - imports `./route.js` (the compiled component) as `default`
 *   - imports `render` from `runtimeImport` (defaults to
 *     `./runtime/index.js`, which `createWorkerdExecutor`'s inlined
 *     runtime modules satisfy)
 *   - exports an `async (input) => render(component, ctx)` entrypoint
 *
 * Workers-runtime safe — imports nothing from `node:*`.
 */

import type { TaskBundle } from "@astroflare/core";

export const DEFAULT_RUNTIME_IMPORT = "./runtime/index.js";

export interface BuildRenderTaskOptions {
	/** The compiled `.astro` JS source. Becomes `route.js` in the bundle. */
	routeCode: string;
	/**
	 * Module specifier the shim uses to import `{ render }`. Defaults to
	 * `"./runtime/index.js"` — the key `createWorkerdExecutor`'s inlined
	 * runtime map exposes. Tests or hosts using a different runtime
	 * layout pass an alternative specifier here.
	 */
	runtimeImport?: string;
}

/**
 * The JSON-shaped input the produced task expects. The shim
 * reconstitutes `Request` and `URL` instances from the JSON-friendly
 * fields, since the executor's RPC boundary doesn't preserve them.
 *
 * `kind: "paths"` short-circuits the shim to invoke the route's
 * `getStaticPaths()` instead of rendering. Used by `createPreviewHandler`
 * to enumerate dynamic-route params; the bundle returns `null` if the
 * module doesn't export `getStaticPaths`.
 */
export type RenderTaskInput =
	| {
			kind?: "render" | undefined;
			url: string;
			method?: string;
			props?: Record<string, unknown>;
			params?: Record<string, string>;
			site?: string;
	  }
	| { kind: "paths" };

/**
 * Result of `RenderTaskInput` with `kind: "paths"`. `null` means the
 * route module doesn't export `getStaticPaths` (which is an error for
 * dynamic routes — caught upstream).
 */
export type StaticPathsResult = ReadonlyArray<{
	params: Record<string, string>;
	props?: Record<string, unknown>;
}> | null;

/**
 * Build a `TaskBundle` that, when executed, renders the supplied route
 * code and returns a `RenderResult`. The bundle is intentionally
 * bare — the executor merges in any host-supplied runtime modules.
 */
export function buildRenderTask(opts: BuildRenderTaskOptions): TaskBundle {
	const runtimeImport = opts.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;
	const shim = [
		'import component from "./route.js";',
		'import * as __route from "./route.js";',
		`import { render } from ${JSON.stringify(runtimeImport)};`,
		"export default async (input) => {",
		'  if (input && input.kind === "paths") {',
		"    const fn = __route.getStaticPaths;",
		"    return fn ? await fn() : null;",
		"  }",
		'  const request = new Request(input.url, { method: input.method ?? "GET" });',
		"  const ctx = {",
		"    props: input.props ?? {},",
		"    params: input.params ?? {},",
		"    request,",
		"    url: new URL(input.url),",
		"    site: input.site,",
		"  };",
		"  return await render(component, ctx);",
		"};",
	].join("\n");

	return {
		mainModule: "main.js",
		modules: {
			"main.js": shim,
			"route.js": opts.routeCode,
		},
	};
}

/** The module path the bundle imports the baked content snapshot from. */
export const CONTENT_MODULE_PATH = "content.js";

export interface BuildClosureRenderTaskOptions {
	/**
	 * The pre-bundled ESM produced by `inlineBundle()` from
	 * `@astroflare/preview/bundle`. Its default export must be
	 * `async (ctx) => RenderResult` — the bundle's own wrapper handles
	 * the call into `render(...)`.
	 */
	bundleCode: string;
	/**
	 * Host-baked content snapshot module source (from
	 * `createContentRuntimeModule(site).source`). When present it's
	 * added to the bundle as `content.js`, which the inline bundler's
	 * `import * as __aflareContent from "./content.js"` resolves
	 * against — this is what makes `import { getCollection } from
	 * "astro:content"` work inside `.astro` frontmatter and
	 * `getStaticPaths()`. Pass `inlineBundle(..., "./content.js")` when
	 * you set this so the bundle actually references it.
	 */
	contentModuleSource?: string;
}

/**
 * Build a `TaskBundle` for a multi-module closure (route + transitively-
 * imported `.astro`/`.md`/`.mdx` deps) that has already been flattened
 * into a single ESM by `inlineBundle()`. The shim's job is just the
 * JSON ↔ live-object marshalling at the executor boundary; the bundle
 * itself owns module-resolution and the `render` call.
 *
 * Mirrors `buildRenderTask` in shape — same input fields, same
 * `RenderResult` output — so callers can swap `buildRenderTask` for
 * this without touching the executor wiring.
 */
export function buildClosureRenderTask(opts: BuildClosureRenderTaskOptions): TaskBundle {
	const shim = [
		'import bundle from "./bundle.js";',
		"export default async (input) => {",
		// Dynamic-route params enumeration: the inline-bundled wrapper
		// already discriminates `ctx.kind === "paths"` (see
		// `inlineBundle` in `@astroflare/preview/bundle`). Pass it
		// through verbatim — the bundle returns the
		// `getStaticPaths()` result, or `null` if the route doesn't
		// export one.
		'  if (input && input.kind === "paths") {',
		'    return await bundle({ kind: "paths" });',
		"  }",
		'  const request = new Request(input.url, { method: input.method ?? "GET" });',
		"  const ctx = {",
		"    props: input.props ?? {},",
		"    params: input.params ?? {},",
		"    request,",
		"    url: new URL(input.url),",
		"    site: input.site,",
		"  };",
		"  return await bundle(ctx);",
		"};",
	].join("\n");

	const modules: Record<string, string> = {
		"main.js": shim,
		"bundle.js": opts.bundleCode,
	};
	if (opts.contentModuleSource !== undefined) {
		modules[CONTENT_MODULE_PATH] = opts.contentModuleSource;
	}

	return { mainModule: "main.js", modules };
}
