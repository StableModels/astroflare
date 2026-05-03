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
export { Image, Picture } from "./components.js";
// Phase 16: hydration runtime — `HYDRATION_CLIENT_SOURCE` is the JS
// the preview / deploy server serves at `/_aflare/hydration.js`;
// `registerAstroIsland` is the programmatic registration entrypoint.
export { HYDRATION_CLIENT_SOURCE, registerAstroIsland } from "./hydration-client.js";
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
