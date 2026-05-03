/**
 * @astroflare/build — workers-runtime-safe surface (Phase 26b).
 *
 * Exports the framework's build primitives that run inside a
 * Cloudflare Worker:
 *
 *   - `createSnapshotHandler` — request handler over a `Snapshots`
 *     capability (typically backed by `R2Snapshots`).
 *   - `buildSite` — the Workers-runtime build orchestrator. Takes a
 *     `Site` + `Executor`, yields `SnapshotEntry`s callers pipe into
 *     a `SnapshotSink`. Mirrors the Node version but uses Web Crypto
 *     and the framework's `Executor` interface — no `node:*`
 *     imports, so hosts can pre-render snapshots from inside a DO
 *     without dialing out to a Node side-car.
 *   - `buildRenderTask` — shared helper that wraps compiled `.astro`
 *     route code into a `TaskBundle`. Used by `buildSite` here and by
 *     `createPreviewHandler` over in `@astroflare/host-cloudflare`.
 *
 * The Node-only build pipeline (`LocalSite`, the Node `buildSite`,
 * `deploySite`) lives at `@astroflare/build/node` because it imports
 * `node:crypto` / `node:fs` etc. that workerd bundlers can't resolve.
 */

export {
	createSnapshotHandler,
	type CreateSnapshotHandlerOptions,
	type SnapshotHandler,
} from "./snapshot-handler.js";

export {
	buildSite,
	type WorkersBuildSiteOptions,
} from "./build-site-workers.js";

export {
	buildRenderTask,
	DEFAULT_RUNTIME_IMPORT,
	type BuildRenderTaskOptions,
	type RenderTaskInput,
} from "./render-task.js";

export const BUILD_VERSION = "0.0.0";
