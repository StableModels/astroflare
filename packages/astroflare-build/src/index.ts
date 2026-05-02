/**
 * @astroflare/build — deploy-time orchestration: planner, bundle, render fan-out, artifact format.
 *
 * Phase 7 fills these. The bundle phase runs in a Bundle DW (esbuild-wasm); the render
 * fan-out is a Workflow that spawns one Render DW per prerenderable route via
 * `Executor.runCached`. Output is content-addressed at `/site/<deployHash>/...`.
 */
export const BUILD_VERSION = "0.0.0";
