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

export const HOST_CLOUDFLARE_VERSION = "0.0.0";
