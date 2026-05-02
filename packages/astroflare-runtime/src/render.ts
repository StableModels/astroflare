/**
 * Public `render()` — the framework-side entrypoint that the preview server,
 * build pipeline, and any user-facing tooling all funnel through.
 *
 * Takes a compiled `.astro` component (the default export from a Phase 2
 * compileAstro output, wrapped in `$component`) plus a `RenderContext`, builds
 * the `AstroGlobal` the user's frontmatter sees, invokes the component, and
 * either collapses the result into an HTML string (the normal path) or
 * propagates a `Response` (when the user returned `Astro.redirect(...)`).
 *
 * The `RenderResult` shape is JSON-serialisable so it survives the
 * Worker-Loader RPC boundary intact (§9.1).
 */
import type { AstroGlobal, RenderContext, RenderResult } from "@astroflare/core";
import { CookieJar } from "./cookies.js";
import {
	type AstroComponent,
	ResponseSignal,
	type SlotMap,
	makeAstroSlots,
	renderToString,
	withRenderContext,
} from "./internal.js";

export interface RenderOptions {
	/** Slots to pass into the component (default: empty). */
	slots?: SlotMap;
}

/**
 * Render a compiled component to a `RenderResult`.
 *
 * @param component  The compiled component (default export of `compileAstro` output).
 * @param context    Per-request context: props, params, request, url, site, locals.
 * @param options    Slots, and (later) integration hooks.
 */
export async function render<P>(
	component: AstroComponent<{ Astro: AstroGlobal<P> } & P>,
	context: RenderContext<P>,
	options: RenderOptions = {},
): Promise<RenderResult> {
	const cookies = new CookieJar(context.request);
	const locals = (context.locals as Record<string, unknown>) ?? {};
	const slots: SlotMap = options.slots ?? {};

	// Establish the per-request context so nested $renderComponent calls can
	// build child Astros that share cookies / locals / request / url / params
	// with the route.
	return withRenderContext(
		{
			request: context.request,
			url: context.url,
			params: context.params,
			site: context.site,
			cookies,
			locals,
		},
		async () => {
			try {
				const astro = createAstroGlobal(context, { cookies, locals, slots });
				const result = await component({ Astro: astro, ...context.props }, slots);
				if (result instanceof Response) {
					return responseToResult(result, cookies);
				}
				return {
					kind: "html",
					html: await renderToString(result),
					cookies: cookies.headers(),
				};
			} catch (err) {
				if (err instanceof ResponseSignal) {
					return responseToResult(err.response, cookies);
				}
				throw err;
			}
		},
	);
}

async function responseToResult(response: Response, cookies: CookieJar): Promise<RenderResult> {
	const headers: Record<string, string> = {};
	for (const [k, v] of response.headers) headers[k] = v;
	const body = response.body ? await response.text() : null;
	return {
		kind: "response",
		status: response.status,
		headers,
		body,
		cookies: cookies.headers(),
	};
}

/**
 * Public helper: build the `Astro` global from a render context. Exported so
 * tests, integrations, and the build pipeline can construct one without
 * re-implementing the rules.
 */
export function createAstroGlobal<P>(
	context: RenderContext<P>,
	parts: {
		cookies: CookieJar;
		locals: Record<string, unknown>;
		slots: SlotMap;
	},
): AstroGlobal<P> {
	return {
		props: context.props,
		params: context.params,
		request: context.request,
		url: context.url,
		site: context.site,
		redirect(to: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
			return new Response(null, { status, headers: { location: to } });
		},
		cookies: parts.cookies,
		locals: parts.locals,
		slots: makeAstroSlots(parts.slots),
	};
}
