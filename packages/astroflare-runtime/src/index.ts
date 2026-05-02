/**
 * @astroflare/runtime — server render() + browser hydration.
 *
 * The public surface is the runtime ABI in `internal.ts`. This file just
 * re-exports the symbols compiled `.astro` modules need, plus a few public
 * types. Browser-side HMR and hydration runtimes land in Phase 5 and Phase 8
 * respectively (`hmr-client.ts`, `hydration.ts`).
 */
export * from "./internal.js";

export const RUNTIME_VERSION = "0.0.0";
