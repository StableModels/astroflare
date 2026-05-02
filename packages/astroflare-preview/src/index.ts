/**
 * @astroflare/preview — the live dev-loop heart.
 *
 * Phase 4 fills `module-graph.ts`, `url-rewrite.ts`. Phase 5 fills `hmr-protocol.ts`.
 * Phase 3 wires a minimal `preview-server.ts` that handles request → compile via
 * `Executor.runCached(contentHash)` → render → response. No bundling, ever.
 */
export const PREVIEW_VERSION = "0.0.0";
