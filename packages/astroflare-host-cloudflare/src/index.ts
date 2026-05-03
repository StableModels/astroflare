/**
 * @astroflare/host-cloudflare — the only package allowed to import Cloudflare APIs.
 *
 * Phase 2.5c lands `executor.ts` (Worker Loader-backed `Executor`). Future
 * phases wire `storage.ts`, `coordinator-do.ts`, `transport.ts`,
 * `project-worker.ts`, and the RPC service classes (`FsService`,
 * `LogService`, `ImageService`, `EnvService`) per §9.3.
 *
 * Acceptance criterion §11.5 explicitly carves out this package: it is the
 * *only* one where `cloudflare:` and `@cloudflare/` imports are allowed.
 */
// Phase 26 / 26b — host-driven library surface. Astroflare ships
// zero canonical DO classes and zero canonical worker entrypoints;
// hosts compose these factories + adapters inside their own
// SiteDurableObject / worker.
export * from "./executor.js";
export * from "./coordinator.js";
export * from "./preview-handler.js";
export * from "./accept-hmr-socket.js";
export * from "./sql-cache.js";
export * from "./runtime-bundled-executor.js";
export * from "./r2-snapshots.js";

export const HOST_CLOUDFLARE_VERSION = "0.0.0";
