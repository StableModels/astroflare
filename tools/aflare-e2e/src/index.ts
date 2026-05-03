/**
 * `@astroflare/e2e` — capstone CLI for Phase 20 end-to-end testing
 * against live Cloudflare.
 *
 * Five command groups (per `docs/next-phases.md` §"Phase 20"):
 *
 *   PROVISION    create Worker + R2 + DOs for a fixture
 *   ORCHESTRATE  build → deploy → run vitest spec → verify
 *   INTROSPECT   list provisioned, status check, inspect details
 *   OBSERVE      tail logs, fetch metrics, trace events  (Phase 20a)
 *   TEARDOWN     destroy resources, gc orphans
 *
 * Phase 20 ships PROVISION + ORCHESTRATE + INTROSPECT + TEARDOWN.
 * OBSERVE is deferred — wrangler tail handles the immediate need;
 * a structured per-fixture tail comes when there's a real workflow.
 *
 * Resource state lives in `tests/e2e/.state/<sha7>/<fixture>.json`
 * (gitignored). Names are deterministic so concurrent CI on
 * different SHAs doesn't collide.
 *
 * The CLI never reaches Cloudflare from a test run — `api.ts`
 * accepts a `fetch` injection point so unit tests can drive the
 * full provision/deploy/teardown ceremony against a mock without
 * burning real resources. Production CI binds the live `fetch`
 * via the `aflare-e2e` binary's main entry.
 */

export { Cli } from "./cli.js";
export { type CloudflareClient, makeCloudflareClient } from "./api.js";
export { type FixtureState, readFixtureState, writeFixtureState } from "./state.js";
export { provisionFixture } from "./commands/provision.js";
export { teardownFixture } from "./commands/teardown.js";
export { listFixtures } from "./commands/list.js";
export { inspectFixture } from "./commands/inspect.js";
export { statusReport, type FixtureStatus } from "./commands/status.js";
export { findOrphanWorkers, type GcResult } from "./commands/gc.js";
