/**
 * Public `render()` — the framework-side entrypoint that the preview server,
 * build pipeline, and any user-facing tooling all funnel through.
 *
 * Takes a compiled `.astro` component (the default export from a Phase 2
 * compileAstro output, wrapped in `$component`) plus a `RenderContext`, builds
 * the `AstroGlobal` the user's frontmatter sees, invokes the component, and
 * collapses the result into an HTML string.
 *
 * Deliberately small. The compiler-emitted ABI does the heavy lifting: every
 * tag, expression, slot, and component reference is already a runtime call by
 * the time this function executes. Phase 3 wires only the request/response
 * shape — Phase 4+ adds streaming, integrations, middleware, `Astro.cookies`,
 * `Astro.locals`, `Astro.slots`, `Astro.self`, and the rest of the Astro API
 * surface.
 */
import type { AstroGlobal, RenderContext } from "@astroflare/core";
import { type AstroComponent, type RawHtml, type SlotMap, renderToString } from "./internal.js";

export interface RenderOptions {
	/** Slots to pass into the component (default: empty). */
	slots?: SlotMap;
}

/**
 * Render a compiled component to an HTML string.
 *
 * @param component  The compiled component (default export of `compileAstro` output).
 * @param context    Per-request context: props, params, request, url, site.
 * @param options    Slots, and (later) integration hooks.
 */
export async function render<P>(
	component: AstroComponent<{ Astro: AstroGlobal<P> } & P>,
	context: RenderContext<P>,
	options: RenderOptions = {},
): Promise<string> {
	const astro = createAstroGlobal(context);
	const result: RawHtml = await component({ Astro: astro, ...context.props }, options.slots ?? {});
	return renderToString(result);
}

/**
 * Public helper: build the `Astro` global from a render context. Exported so
 * tests, integrations, and the build pipeline can construct one without
 * re-implementing the rules.
 */
export function createAstroGlobal<P>(context: RenderContext<P>): AstroGlobal<P> {
	return {
		props: context.props,
		params: context.params,
		request: context.request,
		url: context.url,
		site: context.site,
		redirect(to: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
			return new Response(null, { status, headers: { location: to } });
		},
	};
}
