/**
 * @astroflare/preview — the live dev-loop heart.
 *
 * Phases 3–5 build out:
 *   - `router.ts`           — file-based routing for `src/pages/`
 *   - `module-graph.ts`     — closure walker + per-module compile cache
 *   - `bundle.ts`           — inline bundler (single-file ESM bundles)
 *   - `url-rewrite.ts`      — ESM import extractor + rewriter
 *   - `inject-hmr.ts`       — HMR client `<script>` injection
 *   - `preview-server.ts`   — request → render → response, plus `/_aflare/hmr`
 */
export * from "./router.js";
export * from "./module-graph.js";
export * from "./bundle.js";
export * from "./url-rewrite.js";
export * from "./inject-hmr.js";
export * from "./endpoint.js";
export * from "./middleware.js";
export * from "./preview-server.js";

export const PREVIEW_VERSION = "0.0.0";
