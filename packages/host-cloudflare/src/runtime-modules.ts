/**
 * Public sub-path entry: `@astroflare/host-cloudflare/runtime-modules`.
 *
 * Hosts that embed `createWorkerdExecutor` previously had to wire the
 * runtime module map themselves — typically via an esbuild `define`
 * substitution for `__AFLARE_RUNTIME_MODULES__`, a custom plugin, or
 * hand-rolled string concatenation. This entry removes that step:
 *
 * ```ts
 * import { runtimeModules } from "@astroflare/host-cloudflare/runtime-modules";
 * import { createWorkerdExecutor } from "@astroflare/host-cloudflare";
 *
 * const executor = createWorkerdExecutor({
 *   loader: env.LOADER,
 *   runtime: runtimeModules,
 * });
 * ```
 *
 * The map is regenerated from `@astroflare/runtime/dist/*.js` whenever
 * the runtime is rebuilt — see `scripts/generate-runtime-modules.mjs`.
 * Determinism is enforced (sorted keys, JSON-stringified values, no
 * timestamps) so the checked-in file doesn't churn lockfiles.
 *
 * The legacy `__AFLARE_RUNTIME_MODULES__` global-substitution pattern
 * still works for hosts that prefer it; this is the recommended path
 * because it's bundler-agnostic (esbuild, bun, wrangler, rollup,
 * turbopack — anything that supports a sub-path import).
 */

export { runtimeModules } from "./runtime-modules.generated.js";
