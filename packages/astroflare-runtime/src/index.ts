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

export const RUNTIME_VERSION = "0.0.0";
