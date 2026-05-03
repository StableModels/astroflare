# CLAUDE.md — agent runbook

Concise pointers for working in this repo. **The code is authoritative.**
When this file disagrees with reality, fix the file in the same change
that touched the code.

## How to use this file

- Read it at session start. It's the index, not the manual.
- It links to authoritative sources (specs, retros, code) — follow the
  links rather than duplicating their content here.
- When you change behavior that this file describes (e.g. add a CLI
  verb, change a test layer), update this file in the same commit. If
  you wouldn't update it, you're probably not touching the things it
  describes — move on.
- If something here is stale, fix it. Don't work around it.

## Architectural North Star — framework, not app

Astroflare is a **library**. The host brings everything stateful:
filesystem, Durable Objects, Worker entrypoint, lifecycle.
Astroflare receives capabilities (`Site`, `Executor`, `Cache`) and
runs framework logic over them. It may ship convenience helpers,
but never *is* the app.

Concretely:
- **Zero Astroflare-owned DO classes.** The host's DO holds state;
  Astroflare provides factories the host calls inside its DO
  constructor.
- **Zero canonical worker entrypoint.** The host writes its
  worker; Astroflare provides request-handler factories.
- **Storage is host-supplied** through the narrow `Site` interface.
  Filesystem adapters (e.g. `@astroflare/site-workspace`) live in
  separate opt-in packages so the framework doesn't import
  `@cloudflare/shell`, R2 bindings, etc.
- **Astroflare-internal state** (module graph, compile cache)
  lives in the host's sqlite under the `aflare_*` table prefix.

Guardrail when adding code: if a change makes Astroflare own a
binding, a DO, a worker entrypoint, or runtime lifecycle, push it
across the boundary into the host. Mode B's **build** step is a
library function (`buildSite`) the host invokes — exempt from the
runtime-ownership rules; runs from anywhere (local, CI, in-Worker)
via the `Executor` abstraction. Mode B's **serve** step is a worker,
fully subject to the rules: Astroflare ships a request-handler
factory and an `R2Snapshots` adapter, never the worker entrypoint;
the host owns the worker, the storage binding, and the path layout.
**Status (post-Phase 26 / 26b / 26c finalization):** the public
host API surface is fully aligned. Hosts write their own
`SiteDurableObject` (Mode A) or deploy worker (Mode B); they
import `createCoordinator` / `createPreviewHandler` /
`acceptHmrSocket` / `SqlCache` / `createWorkerdExecutor` from
`@astroflare/host-cloudflare` and `WorkspaceSite` from
`@astroflare/site-workspace` (Mode A); `createSnapshotHandler`
from `@astroflare/build` and `R2Snapshots` / `R2SnapshotSink`
from `@astroflare/host-cloudflare` (Mode B). The legacy
`stack-worker.ts`, `project-worker.ts`, `R2Storage`,
`CoordinatorDurableObject`, `HmrDurableObject`,
`createDeployServer`, and the `deploy()` build function are all
gone. Reference fixtures
([`tests/e2e/fixtures/preview-host-ref/`](tests/e2e/fixtures/preview-host-ref/),
[`tests/e2e/fixtures/deploy-host-ref/`](tests/e2e/fixtures/deploy-host-ref/))
build cleanly into deployable bundles.

The `Storage` interface in `@astroflare/core` remains
`@deprecated` but is still consumed by framework-internal code
(`@astroflare/preview`'s preview-server, `@astroflare/content`'s
collection reader, `@astroflare/test-utils`). Migrating those
internals from `Storage` → `Site` + `Cache` is a separate refactor
that doesn't change the host-facing API and doesn't violate the
North Star (implementation detail, not host surface).

Phase plans:
[`docs/phases/phase-26-host-driven-preview.md`](docs/phases/phase-26-host-driven-preview.md),
[`docs/phases/phase-26b-host-driven-build.md`](docs/phases/phase-26b-host-driven-build.md),
[`docs/phases/phase-26c-agent-ops-cli.md`](docs/phases/phase-26c-agent-ops-cli.md).

## Project shape

Astroflare is an Astro-compatible content framework that runs on
Cloudflare's isolate primitives. Two lifecycles:

- **Mode A — Preview / in-Worker compile + render.** Host-driven
  (Phase 26). The host application writes a `SiteDurableObject` that
  owns a `@cloudflare/shell` `Workspace` + Astroflare's coordinator
  (`createCoordinator`) + the HMR endpoint. The host's worker calls
  `createPreviewHandler` to render. Astroflare ships zero DOs and
  zero entrypoints. *Requires the paid Workers plan* (Worker
  Loader binding). Reference fixture:
  [`tests/e2e/fixtures/preview-host-ref/`](tests/e2e/fixtures/preview-host-ref/).
- **Mode B — Production deploy.** Compile + render runs locally
  (Node), output lands in R2 as a versioned, atomically-flippable
  *snapshot*. New shape (Phase 26b, additive): host owns its own
  worker that instantiates `R2Snapshots({ bucket, prefix? })` and
  mounts `createSnapshotHandler({ snapshots })`. The `prefix`
  parameter supports multi-env (dev/staging/prod buckets) +
  multi-site (`sites/<id>/`) partitioning. Reference fixture:
  [`tests/e2e/fixtures/deploy-host-ref/`](tests/e2e/fixtures/deploy-host-ref/).
  Legacy `stack-worker.ts` + `R2Storage` + `createDeployServer`
  still in tree until the e2e harness is rewired.

Founding spec: [`docs/cloudflare-validation-plan.md`](docs/cloudflare-validation-plan.md).
Dual-mode plan: [`docs/dual-mode-validation-plan.md`](docs/dual-mode-validation-plan.md).
Per-phase retros: [`docs/phases/`](docs/phases/) (one file per phase, dated).
Next-phase backlog: [`docs/next-phases.md`](docs/next-phases.md).

## Test layers

Run everything: `pnpm test`. Run one project: `pnpm vitest run --project <name>`.

| Layer | Where | Pool | Purpose |
| --- | --- | --- | --- |
| A — Node | `packages/*/src/*.test.ts` | node | Pure framework logic. Fast (~ms). |
| B — workerd | `tests/workerd/` | workerd via `@cloudflare/vitest-pool-workers` | Code that depends on the workerd runtime (Hibernating WS, sqlite DOs) but doesn't need the full framework wired. |
| C — integration | `tests/integration/` | Miniflare via `@cloudflare/vitest-pool-workers` | Full project-worker assembly under Miniflare. R2 + DO + Worker Loader all real (mock-free). Pre-seeds R2 via `env.FILES.put`. |
| D — e2e | `tests/e2e/` | node | **Real Cloudflare.** Provisions one stack per run via the `af` CLI library, deploys fixtures, asserts live behaviour. Skips when `CLOUDFLARE_*` env vars are absent. Mode A e2e coverage is deferred until the reference host fixture (`tests/e2e/fixtures/preview-host-ref/`) gets bundling + globalSetup wiring. |

E2e details: globalSetup provisions a Mode B stack, runs
`deployStaticBundle` for the discovered fixtures, then writes
`tests/e2e/.state/<sha7>/runtime.json` for spec workers to read.
Teardown destroys the stack. Stale state from a credential-less run
is wiped automatically.

## Cloudflare CLI (`af`)

The `@astroflare/cli` package exposes `af`. The same library
(`@astroflare/cli-lib`) backs the e2e test suite, so manual ops
and automated tests share a single registry under
`tests/e2e/.state/<sha7>/`.

Run from source (no build step): `pnpm exec tsx packages/astroflare-cli/src/cli.ts <verb>`.

Stack worker bundle: `node scripts/build-stack-worker.mjs` →
`packages/astroflare-host-cloudflare/dist/stack-worker.bundle.js`
(Mode B). Mode A's preview-worker.ts and its build script are gone
(Phase 26) — preview is host-driven.

| Verb | Purpose |
| --- | --- |
| `provision-stack <n>` / `destroy-stack <n>` | Mode B stack: worker + R2 + DOs + DEPLOY_TOKEN. |
| `deploy-static <fixture-dir> --stack <n>` | Compile + render fixture locally, ship HTML to R2, flip `/site/current`. |
| `init / deploy / status / rollback` | Project lifecycle (Mode B end-user surface). |
| `list / inspect / health` | See *all* managed hosts (legacy fixtures + stacks) — Phase 26c. |
| `gc / destroy / destroy-all` | Account-wide cleanup. |
| `doctor` | Environment sanity check (creds, plan, state) — JSON report (Phase 26c). |
| `snapshot list <stack> [--prefix <p>]` | Enumerate snapshot hashes; marks the active one (Phase 26c). |
| `snapshot current <stack> [--prefix <p>]` | Active snapshot hash (Phase 26c). |
| `snapshot cat <stack> <hash> <route>` | Read raw bytes of one snapshot entry (Phase 26c). |

Mode A has no `af` verbs — preview is host-driven (Phase 26). Hosts
integrate via `@astroflare/host-cloudflare` (`createCoordinator`,
`createPreviewHandler`, `acceptHmrSocket`, `SqlCache`,
`createWorkerdExecutor`) and `@astroflare/site-workspace`
(`WorkspaceSite`).

Credentials: `.dev.vars` holds `CLOUDFLARE_API_TOKEN` (git-crypt locally;
GitHub repo secret in CI). `CLOUDFLARE_ACCOUNT_ID` is exported by
`.envrc` (not secret). Source both before running `af` or e2e tests:
`set -a && . .dev.vars && set +a`.

## Branches

Default branch: `main`. Recent phase work was committed on a
long-running topic branch (see [memory](file:///Users/ryan/.claude/projects/-Users-ryan-dev-stablemodels-astroflare/memory/MEMORY.md)).
**Ask the user before creating new branches** — the policy here is
not "topic branch per phase."

## Memory

Each session has access to a persistent memory store at
`/Users/ryan/.claude/projects/-Users-ryan-dev-stablemodels-astroflare/memory/`.
Index in `MEMORY.md`. Use it for facts the code won't tell you
(account IDs, why a decision was made, plan-tier constraints,
user preferences). Don't duplicate things that live in code,
docs, or git history.
