/**
 * React SSR (Phase 16b).
 *
 * Renders a React component to an HTML string via
 * `react-dom/server#renderToString`. The result wraps in `$rawHtml`
 * so the inline bundler's render path treats the markup as
 * pre-escaped HTML (the user's React DOM Server output is already
 * HTML-safe).
 *
 * The emitter routes `.tsx` / `.jsx` islands through this helper
 * when the corresponding `client:*` directive expects an SSR'd
 * body. Hooks (`useState`, `useEffect`) work the same way they do
 * in a Next.js / Astro SSR pass: state-init runs once, effects do
 * not run.
 *
 * Production deploys must include `react` + `react-dom/server` in
 * the bundle (typical when a project uses React at all). When the
 * import fails — typically because the user added a `.tsx` island
 * without React in `package.json` — the helper logs the cause and
 * returns an empty raw HTML, falling back to client-only rendering.
 * This matches Phase 16's behaviour and keeps the page from
 * exploding on a misconfiguration.
 */

import { $rawHtml, type RawHtml } from "./internal.js";

interface ReactDomServer {
	renderToString: (element: unknown) => string;
}

interface ReactNamespace {
	createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
}

let cachedReact: ReactNamespace | null | undefined;
let cachedDomServer: ReactDomServer | null | undefined;

/**
 * Render a React component to a string of HTML and return it as
 * pre-escaped raw HTML. `Component` is the dynamically-imported
 * component reference (typically `(await import('./Counter.tsx')).default`).
 *
 * On any failure (missing `react` / `react-dom/server`, render
 * throws, hooks-misuse), logs the error and returns empty raw HTML
 * so the surrounding page still renders.
 *
 * Exposed under both `ssrReactIsland` (the import-friendly name) and
 * `$ssrReactIsland` (a `$`-prefixed alias for the runtime ABI the
 * compiler reaches for; same convention as `$component` / `$island`).
 */
export async function ssrReactIsland(
	Component: unknown,
	props: Record<string, unknown> = {},
): Promise<RawHtml> {
	if (typeof Component !== "function") {
		console.warn("[astroflare] ssrReactIsland: component is not a function — skipping SSR");
		return $rawHtml("");
	}
	try {
		const React = await loadReact();
		const ReactDOMServer = await loadReactDomServer();
		if (!React || !ReactDOMServer) return $rawHtml("");
		const element = React.createElement(Component, props);
		const html = ReactDOMServer.renderToString(element);
		return $rawHtml(html);
	} catch (err) {
		console.warn("[astroflare] React SSR failed; falling back to client-only render:", err);
		return $rawHtml("");
	}
}

/** Compiler ABI alias for `ssrReactIsland`. */
export const $ssrReactIsland = ssrReactIsland;

/**
 * Cache the `react` namespace import. Returns `null` when React
 * isn't installed or fails to load — caller treats that as a
 * fall-back-to-client-only signal.
 */
async function loadReact(): Promise<ReactNamespace | null> {
	if (cachedReact !== undefined) return cachedReact;
	try {
		const mod = (await import("react")) as ReactNamespace;
		cachedReact = mod;
		return mod;
	} catch (err) {
		console.warn("[astroflare] react module not available:", err);
		cachedReact = null;
		return null;
	}
}

async function loadReactDomServer(): Promise<ReactDomServer | null> {
	if (cachedDomServer !== undefined) return cachedDomServer;
	try {
		// Use the legacy `renderToString` entry. React 18's `renderToString`
		// works without any DOM globals — it's a synchronous tree walk that
		// returns the SSR string.
		const mod = (await import("react-dom/server")) as ReactDomServer;
		cachedDomServer = mod;
		return mod;
	} catch (err) {
		console.warn("[astroflare] react-dom/server not available:", err);
		cachedDomServer = null;
		return null;
	}
}

/**
 * Test-only helper: clear the cached React modules so a test that
 * stubs them takes effect on the next call. Not exported from the
 * top-level barrel because production code never needs it.
 */
export function __resetReactCacheForTests(): void {
	cachedReact = undefined;
	cachedDomServer = undefined;
}
