/**
 * @astroflare/host-cloudflare — the only package allowed to import Cloudflare APIs.
 *
 * Phase 1b stubs `storage.ts`, `executor.ts`, `coordinator-do.ts`, `transport.ts`.
 * Phase 3+ wire `project-worker.ts` (entrypoint Worker, exports DO classes, exposes
 * RPC services) and `rpc-services.ts` (FsService, LogService, ImageService, EnvService
 * — see §9.3).
 *
 * Acceptance criterion §11.5 explicitly carves out this package: it is the *only* one
 * where `cloudflare:` and `@cloudflare/` imports are allowed.
 */
export const HOST_CLOUDFLARE_VERSION = "0.0.0";
