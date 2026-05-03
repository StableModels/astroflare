/**
 * `@astroflare/cli-lib` — orchestration library for managed
 * Cloudflare Workers.
 *
 * Backs the `af` binary (in `@astroflare/cli`) and is also usable
 * directly for ad-hoc work — debugging a specific deploy,
 * reproducing a production issue against an isolated Worker,
 * scripting cleanup of stale resources. The e2e test suite
 * (`tests/e2e/`) consumes the same surface for its globalSetup /
 * globalTeardown.
 *
 * Surface:
 *   - `makeCloudflareClient({ accountId, apiToken })` — REST
 *     wrapper covering Workers + R2 + workers.dev subdomain.
 *   - `provisionFixture` / `teardownFixture` — create / destroy a
 *     managed Worker + R2 bucket. Idempotent. The "Fixture" naming
 *     is historical; the functions operate on any named Worker
 *     bundle, not just test fixtures.
 *   - `listFixtures` / `inspectFixture` — read the local
 *     `tests/e2e/.state/<sha7>/` registry.
 *   - `statusReport` — HEAD each managed URL.
 *   - `findOrphanWorkers` — diff the live account against local
 *     state.
 *
 * State lives under `tests/e2e/.state/<sha7>/<name>.json`
 * (gitignored). Same path the `af` CLI and the e2e test suite both
 * read + write, so manual ops and automated tests share a registry.
 */

export {
	type CloudflareClient,
	type UploadWorkerWithBindingsInput,
	type WorkerBinding,
	makeCloudflareClient,
} from "./api.js";
export {
	type FixtureState,
	type StackState,
	type PreviewState,
	readFixtureState,
	writeFixtureState,
	readStackState,
	writeStackState,
	readPreviewState,
	writePreviewState,
} from "./state.js";
export { provisionFixture } from "./commands/provision.js";
export { teardownFixture } from "./commands/teardown.js";
export { listFixtures } from "./commands/list.js";
export { inspectFixture } from "./commands/inspect.js";
export { statusReport, type FixtureStatus } from "./commands/status.js";
export { findOrphanWorkers, type GcResult } from "./commands/gc.js";
export {
	provisionStack,
	destroyStack,
	loadStackWorkerBundle,
	type ProvisionStackInput,
	type DestroyStackInput,
	type DestroyStackResult,
} from "./commands/provision-stack.js";
export {
	deployStaticBundle,
	type DeployStaticInput,
	type DeployStaticResult,
	type DeployedRoute,
	type FixtureSource,
} from "./commands/deploy-static.js";
// Mode A preview is host-driven now (Phase 26): hosts write their own
// SiteDurableObject + worker using @astroflare/host-cloudflare's
// `createCoordinator`, `createPreviewHandler`, `acceptHmrSocket`, and
// `@astroflare/site-workspace`'s `WorkspaceSite`. The CLI no longer has
// `provision-preview` / `destroy-preview` / `upload-files` verbs — Mode A
// provisioning belongs in the host application's lifecycle, not in `af`.
