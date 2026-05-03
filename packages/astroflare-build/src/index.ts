/**
 * @astroflare/build — workers-runtime-safe surface (Phase 26b).
 *
 * This entry exports only what runs inside a Cloudflare Worker:
 * `createSnapshotHandler`. The Node-only build pipeline (`LocalSite`,
 * `buildSite`, `deploySite`) lives at `@astroflare/build/node`
 * because it imports `node:crypto` / `node:fs` etc. that workerd
 * bundlers can't resolve.
 */

export {
	createSnapshotHandler,
	type CreateSnapshotHandlerOptions,
	type SnapshotHandler,
} from "./snapshot-handler.js";

export const BUILD_VERSION = "0.0.0";
