/**
 * @astroflare/runtime — server render() + browser hydration.
 *
 * The public surface is split into:
 *   - `internal.ts` — the runtime ABI compiled `.astro` modules import against
 *     ($component, $render, $renderComponent, $renderSlot, ...). Internal in
 *     name only; re-exported here so framework code can use it directly.
 *   - `render.ts` — the framework-facing `render()` entrypoint that the
 *     preview server, build pipeline, and any user tooling funnel through.
 *
 * Browser-side HMR and hydration runtimes land in Phase 5 and Phase 8
 * respectively (`hmr-client.ts`, `hydration.ts`).
 */
export * from "./internal.js";
export * from "./render.js";
export * from "./hmr-client.js";
export { CookieJar } from "./cookies.js";
export { Image, Picture, ViewTransitions, Prefetch } from "./components.js";
// Phase 16: hydration runtime — `HYDRATION_CLIENT_SOURCE` is the JS
// the preview / deploy server serves at `/_aflare/hydration.js`;
// `registerAstroIsland` is the programmatic registration entrypoint.
export { HYDRATION_CLIENT_SOURCE, registerAstroIsland } from "./hydration-client.js";
// Phase 17: view-transitions + prefetch client scripts. Surfaced both
// as typed installers (for tests and programmatic users) and as source
// strings the preview/deploy server ships at fixed `/_aflare/*` paths.
export {
	VIEW_TRANSITIONS_CLIENT_SOURCE,
	installViewTransitions,
	type ViewTransitionsClient,
	type InstallViewTransitionsOptions,
} from "./view-transitions-client.js";
export {
	PREFETCH_CLIENT_SOURCE,
	installPrefetch,
	type PrefetchClient,
	type InstallPrefetchOptions,
} from "./prefetch-client.js";
// Phase 17: RSS + sitemap XML helpers. Pure functions — caller wires
// them into an endpoint route.
export {
	generateRss,
	formatRssDate,
	type RssFeedInput,
	type RssFeedItem,
} from "./rss.js";
export {
	generateSitemap,
	formatSitemapDate,
	buildSitemapFromRoutes,
	type SitemapInput,
	type SitemapUrlEntry,
	type RouteForSitemap,
	type BuildSitemapOptions,
} from "./sitemap.js";
// Phase 18: i18n routing helpers. `deriveLocale` is what the router
// uses to populate `Astro.currentLocale`; the others are user-facing
// link / negotiation helpers (`getRelativeLocaleUrl`,
// `getAbsoluteLocaleUrl`, `getLocaleByPath`, `parsePreferredLocales`).
export {
	deriveLocale,
	getRelativeLocaleUrl,
	getAbsoluteLocaleUrl,
	getLocaleByPath,
	parsePreferredLocales,
} from "./i18n.js";
// Phase 19: dev/preview error overlay. Surfaces hydration + HMR
// failures as a modal instead of a silent console.error. The string
// form is auto-injected by the preview server so the overlay is
// available before any user JS runs.
export {
	ERROR_OVERLAY_CLIENT_SOURCE,
	showAstroflareError,
	dismissAstroflareError,
	type AflareErrorReport,
} from "./error-overlay.js";
// Phase 16a: React adapter for `.tsx` islands. The compile-time
// `wrapReactIslandSource(src)` injects mount glue around a default-
// exported component; the runtime `/_aflare/react.js` route serves
// `MOUNT_REACT_ISLAND_SOURCE` (default-resolves React via esm.sh).
export {
	MOUNT_REACT_ISLAND_SOURCE,
	wrapReactIslandSource,
	findDefaultExport,
} from "./react-adapter.js";
// Phase 16b: React SSR with hooks. `ssrReactIsland(Component, props)`
// renders a `.tsx` island server-side via `react-dom/server#renderToString`.
// Production deploys must include `react-dom/server` in the bundle;
// the helper falls back to empty raw HTML (client-only render) when
// the import fails.
export { ssrReactIsland } from "./react-ssr.js";
// JSX runtime — re-exported so a `runtimeImport` URL pointing at this
// entrypoint can supply `jsx`, `jsxs`, `jsxDEV`, and `Fragment` from a
// single source. The MDX compiler post-processes its output to alias
// `_jsx` / `_jsxs` / `_Fragment` against these shared bundle-scope names
// (see `mdx/index.ts`).
export { jsx, jsxs, jsxDEV, Fragment } from "./jsx-runtime.js";
// Phase 15a: `getSecret(name)` + `withEnvContext(env, fn)` for runtime
// access to bound Worker secrets. Distinct from Phase 12's compile-time
// `import.meta.env` substitution (which inlines values at compile time).
export { getSecret, getEnvContext, withEnvContext, type EnvContext } from "./env.js";

export const RUNTIME_VERSION = "0.0.0";
