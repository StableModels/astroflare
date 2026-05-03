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

## Project shape

Astroflare is an Astro-compatible content framework that runs on
Cloudflare's isolate primitives. Two lifecycles:

- **Mode A — Preview / in-Worker compile + render.** Sources live in
  R2; `preview-worker.ts` reads source on demand, compiles via
  `compileAstro`, spawns a Worker Loader isolate to render.
  *Requires the paid Workers plan* (Worker Loader binding).
- **Mode B — Production deploy.** Compile + render runs locally
  (Node), HTML lands in R2 under `files/site/<hash>/`,
  `stack-worker.ts` (18 KiB) atomically serves it.

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
| D — e2e | `tests/e2e/` | node | **Real Cloudflare.** Provisions one stack + one preview stack per run via the `af` CLI library, deploys fixtures, asserts live behaviour. Skips when `CLOUDFLARE_*` env vars are absent. |

E2e details: globalSetup provisions both stacks, runs `deployStaticBundle`
for Mode B and `uploadFiles` for Mode A, then writes
`tests/e2e/.state/<sha7>/runtime.json` for spec workers to read.
Teardown destroys both stacks. Stale state from a credential-less run
is wiped automatically.

## Cloudflare CLI (`af`)

The `@astroflare/cli` package exposes `af`. The same library
(`@astroflare/cli-lib`) backs the e2e test suite, so manual ops
and automated tests share a single registry under
`tests/e2e/.state/<sha7>/`.

Run from source (no build step): `pnpm exec tsx packages/astroflare-cli/src/cli.ts <verb>`.

Worker bundles must be pre-built with esbuild scripts:
`node scripts/build-stack-worker.mjs` and
`node scripts/build-preview-worker.mjs`. Both write to
`packages/astroflare-host-cloudflare/dist/`.

| Verb | Purpose |
| --- | --- |
| `provision-stack <n>` / `destroy-stack <n>` | Mode B stack: worker + R2 + DOs + DEPLOY_TOKEN. |
| `deploy-static <fixture-dir> --stack <n>` | Compile + render fixture locally, ship HTML to R2, flip `/site/current`. |
| `provision-preview <n>` / `destroy-preview <n>` | Mode A stack: same as above + Worker Loader binding. |
| `upload-files <fixture-dir> --preview <n>` | Push fixture sources to the preview workspace via `POST /_aflare/file`. |
| `init / deploy / status / rollback` | Project lifecycle (Mode B end-user surface). |
| `list / inspect / health / gc / destroy / destroy-all` | Account-wide ops. |

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
