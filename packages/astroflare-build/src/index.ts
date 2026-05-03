/**
 * @astroflare/build — framework-side build primitives (Phase 26b).
 *
 * Pure functions of source → snapshot output. No filesystem, no R2,
 * no worker entrypoint — those are host concerns.
 *
 * Surface:
 *   - `Site` (re-exported from core) — the read capability buildSite
 *     consumes.
 *   - `LocalSite` — Node-side `Site` for local FS (CLI use).
 *   - `buildSite({ site, prefix? })` — async stream of `SnapshotEntry`s.
 *   - `deploySite({ site, sink, prefix? })` — pipes buildSite into a
 *     sink and commits.
 *   - `createSnapshotHandler({ snapshots })` — request handler for the
 *     host's worker to mount.
 */

export {
	createSnapshotHandler,
	type CreateSnapshotHandlerOptions,
	type SnapshotHandler,
} from "./snapshot-handler.js";
export { LocalSite, type LocalSiteOptions } from "./local-site.js";
export {
	buildSite,
	deploySite,
	type BuildSiteOptions,
	type DeploySiteOptions,
	type DeploySiteResult,
} from "./build-site.js";

export const BUILD_VERSION = "0.0.0";
