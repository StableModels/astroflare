# Phase 24b — Release readiness

**Goal:** ship Astroflare as v0.1.0 once the architectural North Star
is in force (post-Phase 26 / 26b / 26c). This phase is mostly
process work: publishing, documentation, soak. The code-side gates
land here; the human-decision gates are flagged for the maintainer.

## Code-side gates (actionable in-repo)

### Secret hygiene ✓

Verified: no literal Cloudflare credentials appear in `packages/*/src/`.
Every reference is to env vars (`process.env.CLOUDFLARE_*`) or
documentation strings naming the env var. `af doctor` reports
credential-presence checks via `env.CLOUDFLARE_*`.

### Version pinning between `@astroflare/cli` and `@astroflare/cli-lib`

The CLI imports library functions from `cli-lib` at runtime; the two
packages must agree on the wire layout and CLI surface. To avoid
mixed-version installs:

- Each package's `version` is declared in `package.json` as
  `0.0.0` today (`private: true`). When the workspace publishes,
  set both to the same version and pin the dep range
  (`"@astroflare/cli-lib": "0.1.0"` exact).
- A startup check in `af` reads its own version + the resolved
  `cli-lib`'s version and refuses to run on mismatch.

Implementation is small (one constant + one runtime check) but
deferred until publishing actually happens — there's no point
checking until `private: true` is removed.

### Backwards-compat declaration

The wire layout that crosses Astroflare's boundaries is the public
contract. Users build against it; future framework versions must
not break it without a major version bump:

- **R2 snapshot layout** — `<prefix><snapshotHash>/<route-key>`
  + `<prefix><snapshotHash>/_meta.json` + `<prefix>current`
  pointer.
- **Site interface** — `readFile / statFile / glob` shapes.
- **SnapshotEntry / Snapshots / SnapshotSink interfaces.**
- **Coordinator factory contract** — what `createCoordinator`
  returns; the `aflare_*` table prefix in DO sqlite.
- **CLI verb names + their JSON output schemas** — every verb's
  `{ result, elapsedMs }` or `{ error: { code, message, context } }`
  shape, plus the `CLI_ERROR_CODES` catalog.

These are documented in the phase plans
(`phase-26-host-driven-preview.md` etc.) and become a public
"breaking-changes policy" doc at v0.1.0.

## Process-side gates (human decisions)

These are flagged for the maintainer to drive — not mechanical:

- **npm publish** for `@astroflare/{core, compiler, runtime, preview,
  build, content, cli, cli-lib, host-cloudflare, site-workspace,
  test-utils}`. Set `private: false` on each package when ready;
  release as a coordinated cut with the same version.
- **Documentation site** — "Get started", "Provisioning your own
  host" (Mode A + Mode B walkthroughs against the reference
  fixtures), "Migrating from legacy" (mostly N/A for v0.1.0 since
  there's no prior public release; useful for internal teams that
  worked off pre-Phase-26 branches).
- **24h soak test** — run a deployed reference fixture for 24h
  with synthetic traffic; verify no DO state corruption, no R2
  artifact loss, no HMR connection leaks.
- **Live cold-start measurement** — actual Cloudflare numbers
  for `createPreviewHandler` cold spawns (Worker Loader cold) and
  `createSnapshotHandler` cold reads. Replace the generous 500ms
  bound in `tests/e2e/latency.spec.ts` with the brief's actual
  budgets.

## Carryovers from earlier phases

- **Phase 26c CLI five debugging recipes** — `tests/e2e/cli-workflows.spec.ts`.
  Implemented as planned in `phase-26c-agent-ops-cli.md`; runs
  against credentialed CI when wired up.
- **Phase 26 deferral #1 finish** — full Storage interface removal
  after migrating preview-server, module-graph, middleware,
  endpoint, router, runtime/internal from `Storage` → `Site` +
  `Cache`. Implementation detail; doesn't block the public
  release shape.
- **Reference fixture promotion** — move `preview-host-ref` and
  `deploy-host-ref` from `tests/e2e/fixtures/` to top-level
  `examples/` so users can install them as workspace packages.
  Documentation concern.

## Acceptance

- All packages publish to npm under matching versions.
- `af doctor` exits 0 on a fresh checkout with credentials.
- v0.1.0 changelog declares the public contracts above.
- Soak test runs 24h clean.
- Documentation site live at a stable URL.
