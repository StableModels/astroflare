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
 */
export interface RenderTaskInput {
	url: string;
	method?: string;
	props?: Record<string, unknown>;
	params?: Record<string, string>;
	site?: string;
}

/**
 * Build a `TaskBundle` that, when executed, renders the supplied route
 * code and returns a `RenderResult`. The bundle is intentionally
 * bare — the executor merges in any host-supplied runtime modules.
 */
export function buildRenderTask(opts: BuildRenderTaskOptions): TaskBundle {
	const runtimeImport = opts.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;
	const shim = [
		'import component from "./route.js";',
		`import { render } from ${JSON.stringify(runtimeImport)};`,
		"export default async (input) => {",
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

export interface BuildClosureRenderTaskOptions {
	/**
	 * The pre-bundled ESM produced by `inlineBundle()` from
	 * `@astroflare/preview/bundle`. Its default export must be
	 * `async (ctx) => RenderResult` — the bundle's own wrapper handles
	 * the call into `render(...)`.
	 */
	bundleCode: string;
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

	return {
		mainModule: "main.js",
		modules: {
			"main.js": shim,
			"bundle.js": opts.bundleCode,
		},
	};
}
