# Phase 20 — E2E against live Cloudflare

**Goal:** the capstone phase. Every prior phase is verified locally
(unit, miniflare, workerd); Phase 20 closes the loop by exercising
the framework against *real* Cloudflare. A new `aflare-e2e` CLI
provisions resources, drives test runs against deployed URLs, and
tears down — wired into a per-commit (and nightly) GitHub Actions
workflow.

**Status:** scaffolding done. **678 tests / 60 files / 7 pools all
green** (was 658). The CLI ships with mocked-API unit tests; live
provisioning runs only in CI, not from this scope's test runs.

## What landed

### `tools/aflare-e2e/` — orchestrator CLI

New package `@astroflare/e2e` (binary: `aflare-e2e`). Pure Node, no
dependencies beyond `@types/node` and `vitest` (dev). The architecture:

```
tools/aflare-e2e/
  src/
    api.ts             — Cloudflare REST wrapper (fetch-injectable for tests)
    state.ts           — read/write tests/e2e/.state/<sha7>/<fixture>.json
    cli.ts             — argv dispatch + production main()
    commands/
      provision.ts     — create R2 bucket + upload Worker
      teardown.ts      — destroy resources, remove state file
      list.ts          — enumerate provisioned fixtures from .state/
    api.test.ts        — mocked-fetch unit tests for the API wrapper
    cli.test.ts        — full command surface (mocked client)
```

Verbs shipped this phase:

- `provision <fixture>` — create R2 bucket, upload Worker. Idempotent.
- `teardown <fixture>` — destroy resources, remove state file. Idempotent.
- `teardown-all` — walk every fixture in `.state/<sha7>/`, tear down each.
- `list` — show what's provisioned for the current SHA.

Deferred to Phase 20a:
- `build`, `deploy`, `run`, `preview` (these shell out to the existing
  `aflare` CLI + `wrangler` + `vitest`); the architectural slot is
  ready in `cli.ts`'s switch.
- `inspect`, `status` — needs richer state schema first.
- `logs`, `metrics`, `trace` — observability tier.
- `gc` — sweeps Worker scripts in the live account that aren't
  reflected in any `.state/<sha7>/` directory.

### `tests/e2e/` vitest project

A separate vitest project (`name: "e2e"`) wired into
`vitest.workspace.ts` alongside the existing 12. Tests are **opt-in**:
each `*.spec.ts` checks `process.env.AFLARE_E2E_URL` and routes
through `describe.skip` when absent. So `pnpm test` locally never
hits the live network; CI sets the URL before invoking `vitest run`.

`tests/e2e/minimal.spec.ts` — first fixture spec. Two assertions
against the deployed Worker:
1. `GET /` returns 200 with the rendered greeting in HTML.
2. `GET /missing-route` returns 404.

`tests/e2e/fixtures/minimal/` — the source of the deployed site:
`aflare.config.json` + `src/pages/index.astro` rendering "Hello, edge".

### `.github/workflows/e2e.yml`

New workflow on push-to-main + nightly schedule + workflow_dispatch.
Steps:

1. Checkout + pnpm install + typecheck.
2. `aflare-e2e provision minimal` — creates resources, captures URL.
3. `vitest run --project e2e` with `AFLARE_E2E_URL` set.
4. `aflare-e2e teardown-all` in an `if: always()` block — failed
   test runs must not leak resources.

`CLOUDFLARE_API_TOKEN` rides from the repo secret;
`CLOUDFLARE_ACCOUNT_ID` is set as a literal env on the job.
Concurrency group `e2e-<ref>` cancels in-flight runs when a newer
push happens — the e2e budget is per-account, not per-PR.

### `tests/e2e/.state/` gitignored

Per-fixture state files (resource IDs, deployed URL, timestamp) live
under `tests/e2e/.state/<sha7>/<fixture>.json`. `.gitignore` excludes
the directory. The on-disk record means `teardown` and `list` skip
round-trips to the API, and `gc` (Phase 20a) can reconcile.

## Numbers

- **678 tests / 60 files / 7 pools** all green (was 658).
- 22 new tests:
  - `tools/aflare-e2e/src/api.test.ts` — 6 unit tests for the
    Cloudflare REST wrapper using mocked fetch (PUT body shape,
    DELETE-as-idempotent, success=false handling, error
    propagation).
  - `tools/aflare-e2e/src/cli.test.ts` — 13 unit tests covering
    `provisionFixture` / `teardownFixture` / `listFixtures` and
    the `Cli` argv dispatcher (idempotence, force flag, partial-
    teardown error path, dispatch usage / error / success).
  - `tests/e2e/minimal.spec.ts` — 2 e2e specs (skipped locally;
    run only when `AFLARE_E2E_URL` is set in CI).
- Two pools added: `e2e-cli` (the CLI's unit tests under Node) and
  `e2e` (the live-network spec project).
- Framework boundary check still holds: `aflare-e2e` lives outside
  `packages/` so it doesn't bend the framework / host split.

## Surprises

- **`pnpm-workspace.yaml` had `packages/*`/`examples/*`/`tests/*`
  but not `tools/*`.** Adding the new glob was a one-line change
  but easy to miss. CI's `pnpm install --frozen-lockfile` would
  have failed on a workspace mismatch.

- **The vitest workspace already supports test directories outside
  `packages/`.** No changes to root config beyond appending two
  paths to `vitest.workspace.ts`.

- **`describe.skip` is the right escape hatch for opt-in pools.**
  Vitest still counts them in the file total but reports them as
  skipped, so the test summary stays informative. CI sees
  `2 skipped` locally, `2 passed` in production after
  `AFLARE_E2E_URL` is set.

- **The Cloudflare API's `success: false` body on a 200 status
  caught me thinking.** A naïve `res.ok` check passes — the wrapper
  has to `await res.json()` and verify `success !== false` to catch
  Cloudflare's "request was understood but rejected" path
  (validation errors, name conflicts, etc.).

- **Fixture state files stay separate from the existing aflare CLI's
  `aflare.config.json`.** Two different things — `aflare.config.json`
  configures the user's project (they author it); `<fixture>.json`
  in `tests/e2e/.state/` is generated by `aflare-e2e provision`
  and gitignored. Phase 20a may grow the fixture format with metadata,
  but the state-file shape stays operator-only.

## What did NOT land in this run (and why)

- **Real Cloudflare provisioning from these tests.** The CLI's API
  wrapper accepts a `fetchImpl` for unit tests; the production
  binary swaps in `globalThis.fetch`. Driving real provisioning
  would burn account-level resources (Workers, R2 buckets) every
  test run, which doesn't fit the "validate locally, run live in
  CI" model. Live runs happen in the new GitHub Actions workflow.

- **The full Astro fixture corpus.** The plan listed nine fixtures
  (minimal / basics / blog / portfolio / non-html-pages / middleware
  / ssr / framework-react / with-mdx + hackernews). We ship `minimal`
  as the "scaffolding works" check; the rest copy in alongside
  Phase 16a/b (React, with-mdx) and the deferred Tier 3 items as
  they land. Each is roughly 50–200 lines of `.astro` + an
  `e2e.spec.ts`.

- **`build` / `deploy` / `run` verbs.** These shell out to existing
  tools (`@astroflare/cli`'s `aflare deploy` + `wrangler` + the
  vitest `e2e` project). The architectural slot is in `cli.ts`'s
  dispatch table; wiring is straightforward when the workflow
  needs it. Today's workflow uses the existing `aflare-e2e
  provision` + a manual `vitest run --project e2e` which is enough
  for the minimal fixture.

- **`logs` / `metrics` / `trace` (observe tier).** Live observability
  is `wrangler tail`-shaped; not blocking for correctness validation.
  When a real runbook needs it, the API wrapper grows the relevant
  endpoints.

- **Custom-domain provisioning.** Plan deferred this explicitly —
  `*.workers.dev` is sufficient for tests.

- **Multi-region geographic assertions.** Plan deferred —
  workers.dev hits the nearest edge.

- **Load testing / synthetic traffic.** Plan deferred — Phase 20 is
  correctness, not stress.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm test` — **678 tests / 60 files / 7 pools, all green**;
  2 e2e specs correctly skipped locally.
- `aflare-e2e --help` prints usage; `aflare-e2e <unknown>` exits 1.
- The CI workflow is syntactically valid YAML, references the
  existing `secrets.CLOUDFLARE_API_TOKEN`, and runs teardown in
  `if: always()` so a failed run leaves the account clean.
- Framework boundary check — the e2e CLI is in `tools/aflare-e2e/`
  (a separate workspace dir), not in `packages/`, so it doesn't
  bend the framework / host split.

## What the next phase starts from

Phase 20a (the next "fill in the deferred verbs" iteration) inherits:

- A working CLI scaffold with provision / teardown / list.
- A vitest `e2e` project that runs against any URL.
- A CI workflow that's already wired to repo secrets.

Adding a new fixture is mechanical: `tests/e2e/fixtures/<name>/...`
+ `tests/e2e/<name>.spec.ts`. Adding a new verb is similarly
mechanical: a new file under `tools/aflare-e2e/src/commands/` plus
a `case` in the `Cli.run` switch.

After the first real CI run lands, the soak data (latency, cold-
start times against the edge) becomes the source of truth for
acceptance §11.2/3 — the local Miniflare numbers were always a
proxy.
