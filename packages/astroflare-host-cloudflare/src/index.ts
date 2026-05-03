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
export * from "./executor.js";
export * from "./transport.js";
export * from "./r2-storage.js";
export * from "./coordinator-do.js";

// Phase 26 — host-driven preview architecture: the new shape.
export * from "./coordinator.js";
export * from "./preview-handler.js";
export * from "./accept-hmr-socket.js";
export * from "./sql-cache.js";
export * from "./runtime-bundled-executor.js";

// Phase 26b — host-driven build/serve: snapshot adapters.
export * from "./r2-snapshots.js";

export const HOST_CLOUDFLARE_VERSION = "0.0.0";
