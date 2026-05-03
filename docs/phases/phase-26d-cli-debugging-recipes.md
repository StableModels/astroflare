# Phase 26d — CLI debugging-recipe e2e tests

**Goal:** ship the five agent-debugging recipes as live e2e tests
against real Cloudflare. They were specified in
[`phase-26c-agent-ops-cli.md`](./phase-26c-agent-ops-cli.md) as
acceptance signals; the verbs they exercise (`af doctor`,
`af snapshot list/cat/diff/current`, `af exec`, `af logs`, plus the
host's `/_aflare/site/file` endpoints) all landed. The recipes were
deferred because they need real credentials.

**Status:** planned. Single spec file, one PR. Runs nightly against
credentialed CI.

## Why now

The CLI is reshaped for agent ops; the recipes prove the verb set is
*sufficient* for the agent (or a human) to debug a real failure
without writing ad-hoc fetch scripts. Without these tests, a future
regression in any of the introspection paths goes undetected until
the next time the agent needs them.

## What lands

A new spec at `tests/e2e/cli-workflows.spec.ts`, parallel to the
existing fixture / parity / preview-host specs. Self-skips when
credentials aren't sourced.

### Five recipes

Each recipe is one `describe` block driving a sequence of `af`
verbs. The spec doesn't shell out to the `af` binary — it imports
from `@astroflare/cli-lib` directly so the assertion shape is
structured and stable.

1. **Mode A render-failure debugging.** Provision preview host
   (already done by globalSetup). Upload a syntactically broken
   `.astro` source via the host's POST `/_aflare/site/file`. Fetch
   `/` — expect 500 with a compile-failure body. Use
   `af preview cat` (when implemented) or fetch `/_aflare/site/file?path=...`
   to read back the broken source. Replace with a fixed source; fetch
   `/` again — expect 200 with the rendered output. Cleanup.

2. **HMR roundtrip verification.** Open a WebSocket to the preview
   host's `/_aflare/hmr`. Write a fixture file via POST
   `/_aflare/site/file`. Assert: WS receives an `update` message
   referencing the changed path within 5 seconds.

3. **Mode B deploy-mismatch debugging.** Deploy a fixture (already
   done by globalSetup). Use `af snapshot list <stack>` to enumerate
   snapshots; assert exactly one with `current: true`. Use
   `af snapshot cat <stack> <hash> /minimal/` to read the rendered
   bytes; assert they match what the URL returns. Use
   `af snapshot diff <stack> <hashA> <hashB>` against two synthetic
   snapshots (deploy two slightly different fixtures) and assert the
   diff includes the expected `changed` entries.

4. **Mode B rollback verification.** Deploy a known-good fixture
   producing snapshot A. Deploy a slightly modified fixture producing
   snapshot B. Use `af rollback A --to <stack>` and assert
   `af snapshot current <stack>` returns A. Re-fetch the route and
   assert it serves the A content.

5. **Doctor environment diagnosis.** Run `doctor` with full
   credentials — assert all checks ok. Run `doctor` with the
   `CLOUDFLARE_API_TOKEN` env var set to something invalid — assert
   `credentials.token.verified: false` and the error context
   includes the API failure.

## Test coverage (Layer D — credentialed)

- 5 recipes / ~12 assertions total, all against the live e2e stacks
  globalSetup provisioned.
- Each recipe runs in <30s when credentials are available; ~3-min
  total runtime budget.

## Carve-outs

- **Recipe #1 needs `af preview cat` / `af preview files`** — these
  CLI verbs aren't implemented yet (they were sketched in the
  Phase 26c plan but deferred). The recipe instead uses the host's
  POST endpoint as the read-back surface for now. Add a sixth recipe
  exercising those verbs once they land.
- **Recipe #2's WS connection latency** — assertion is loose (5s).
  Tighten to brief §11.3's p95 < 100ms once we have enough samples to
  trust the bound.

## Acceptance signals

- Spec runs in <3min on real Cloudflare.
- All 5 recipes pass on push-to-main + nightly CI.
- A regression in any of `af snapshot {list,cat,diff,current}`,
  `af rollback`, `doctor`, or the preview host's
  `/_aflare/site/file` + `/_aflare/hmr` endpoints surfaces as a
  spec failure.

## Order rationale

Self-contained — depends only on the existing e2e harness and the
verbs that already shipped. Could land any time before v0.1.0;
landing it before the release means the v0.1.0 changelog can claim
"agent-driven CLI ops verified end-to-end."
