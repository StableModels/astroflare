/**
 * `@astroflare/e2e` — orchestration library for managed Cloudflare
 * Workers used by the Astroflare e2e test suite (and `af`'s
 * cross-cutting Worker-management verbs).
 *
 * No CLI surface here — the `af` binary in `@astroflare/cli` is the
 * single user-facing entrypoint. The library exposes:
 *
 *   - `makeCloudflareClient({accountId, apiToken})` — the REST wrapper
 *     (Workers + R2 + subdomain endpoints).
 *   - `provisionFixture` / `teardownFixture` — create / destroy a
 *     managed Worker + R2 bucket.
 *   - `listFixtures` / `inspectFixture` — read the local
 *     `tests/e2e/.state/<sha7>/` registry.
 *   - `statusReport` — HEAD each managed URL.
 *   - `findOrphanWorkers` — diff the live account against local state.
 *
 * The vitest e2e project's globalSetup uses these directly to
 * provision fixtures before tests run, and the `af` CLI wraps the
 * same calls for manual ops.
 */

export { type CloudflareClient, makeCloudflareClient } from "./api.js";
export { type FixtureState, readFixtureState, writeFixtureState } from "./state.js";
export { provisionFixture } from "./commands/provision.js";
export { teardownFixture } from "./commands/teardown.js";
export { listFixtures } from "./commands/list.js";
export { inspectFixture } from "./commands/inspect.js";
export { statusReport, type FixtureStatus } from "./commands/status.js";
export { findOrphanWorkers, type GcResult } from "./commands/gc.js";
