# Phase 26c — Agent operations CLI

**Goal:** make `af` a first-class operational tool the agent uses to
drive Astroflare on real Cloudflare, observe state, and debug
failures end-to-end. Every Astroflare or Cloudflare-adapter
operation should be reachable through a verb; every reachable state
should be inspectable; every failure should surface with enough
structured context to act on.

**Status:** planned 2026-05-03. Sibling to Phase 26 / 26b. Depends
on both — the new commands speak the post-North-Star library shape
(`Site`, `Snapshots`, in-DO coordinator).

## Why now

Two pieces of context shifted the CLI's role:

1. **Astroflare is becoming a library** (Phase 26 / 26b). Hosts
   write their own workers and DOs. The CLI is no longer "the way
   you deploy Astroflare" — it's the way *we* (and the agent
   driving development) drive a reference host through every
   Astroflare path on real Cloudflare to verify it works.
2. **The agent is the primary user.** When a Mode A render fails or
   a Mode B deploy serves stale bytes, the agent needs to localise
   the failure without writing ad-hoc fetch scripts. That requires
   read-back commands, structured errors, and predictable output.

The audit captured at session start surfaced concrete gaps:

- `af inspect` / `af list` / `af health` only handle legacy fixture
  workers — silently skip stack and preview entries.
- Workspace contents, module graph, snapshot contents, deploy
  history are all unreachable through the CLI.
- No `af logs` / `af tail` (Phase 20b deferred).
- No HMR observability — the WS endpoint exists but no client.
- Output is human-prose, not parseable.

Closing those gaps is what this phase does.

## Design principles (agent-first)

| Principle | Implication |
|---|---|
| **Default to JSON** | Every command emits `{ result, elapsedMs }` or `{ error: { code, message, context } }` to stdout. Stderr stays human-readable progress. `--human` flag opts into pretty output |
| **Read-back-after-write** | Any command that mutates state has a read counterpart that returns the post-mutation state. No "fire and hope" |
| **Idempotent where possible** | Re-running a command in steady state is a no-op. Provision detects existing state; deploy with same source produces same hash; teardown of already-gone resources succeeds |
| **No interactive prompts** | The CLI is non-interactive. Confirmation flags (`--force`, `--dry-run`) replace prompts |
| **Structured errors** | Every error is `{ code: string, message: string, context: object }`. Codes are stable (e.g. `STACK_NOT_FOUND`, `R2_AUTH_FAILED`, `WORKER_LOADER_PLAN_REQUIRED`) so the agent can branch on them |
| **Single source of truth** | The CLI shares state under `tests/e2e/.state/<sha7>/` with the e2e harness. No drift between manual ops and automated tests |

## Verb taxonomy

Three top-level groups: **lifecycle**, **introspect**, **observe**.
Plus `doctor` and `exec` for cross-cutting needs.

### Lifecycle (already mostly there; small fixes)

| Verb | Status | Change |
|---|---|---|
| `af provision-host preview <n>` / `provision-host deploy <n>` | New shape | Replaces `provision-preview` / `provision-stack`. Provisions the **reference host worker** (Phase 26 / 26b fixtures) with appropriate bindings. `preview` includes Worker Loader + DOs; `deploy` includes R2 + optional `--prefix` |
| `af destroy-host <n>` | Reshape | Single verb works for either kind (state file discriminates) |
| `af destroy-all` | Same | Iterates all hosts under current SHA |
| `af deploy [dir] --to <stack> [--prefix <p>]` | Same external | Internals: `LocalSite` → `buildSite` → `R2SnapshotSink` |
| `af status --to <stack>` / `af rollback <hash> --to <stack>` | Same | Reads/writes current pointer |

### Introspect — read-back commands (most of the new value)

**Mode A (preview host):**

| Verb | Returns |
|---|---|
| `af preview files <host>` | Workspace listing — `[{ path, bytes, hash, mimeType, modifiedAt }]` |
| `af preview cat <host> <path>` | Raw file bytes (stdout binary or `--json` for `{ path, hash, content: base64 }`) |
| `af preview rm <host> <path>` | Delete a file; returns `{ deleted: true, prune: { paths: [...] } }` showing the HMR prune fanout |
| `af preview write <host> <path> [@local-file or --content @-]` | Write a file; returns `{ path, hash, bytes, update: { paths: [...] } }` showing HMR update fanout |
| `af preview graph <host>` | Module graph dump — `[{ path, hash, imports[], importedBy[] }]` |
| `af preview info <host>` | Workspace info — `{ fileCount, directoryCount, totalBytes, hmrConnections, currentDeploy }` |
| `af preview render <host> <route>` | Force a render of one route, returning `{ status, headers, body, timings: { compileMs, renderMs } }`. Equivalent to `curl` but with structured timing breakdown |

**Mode B (deploy host):**

| Verb | Returns |
|---|---|
| `af snapshot list <host> [--prefix <p>]` | All snapshots — `[{ hash, createdAt, routeCount, totalBytes, current: bool }]` |
| `af snapshot show <host> <hash>` | Routes in a snapshot — `[{ route, bytes, hash, contentType }]` |
| `af snapshot cat <host> <hash> <route>` | Raw bytes (stdout or `--json`) |
| `af snapshot diff <host> <hashA> <hashB>` | Structural diff — `{ added: [routes], removed: [routes], changed: [{ route, oldHash, newHash, sizeDelta }] }` |
| `af snapshot current <host>` | `{ hash, createdAt }` of the current snapshot, or `null` |

**Cross-cutting state:**

| Verb | Returns |
|---|---|
| `af list [--kind preview\|deploy\|all]` | All managed hosts under current SHA. **Fix the bug where `.preview.json` / `.stack.json` are skipped** |
| `af inspect <name>` | Full state file as JSON. **Fix the same bug** |
| `af health [--kind preview\|deploy\|all]` | HEAD each managed URL — `[{ name, kind, url, httpStatus, latencyMs, error? }]`. **Fix the bug where stacks are skipped** |
| `af gc [--dry-run]` | Orphan sweep — `{ orphans: [...], deleted: [...] }`. `--dry-run` lists without acting (currently the only mode; `--apply` lands here) |

### Observe — runtime visibility

| Verb | What |
|---|---|
| `af logs <host> [--tail] [--since 5m]` | Wrangler tail wrapper. JSON lines on stdout — one event per line |
| `af preview hmr-tail <host> [--timeout 30s]` | Connect to `/_aflare/hmr` WS, dump messages as JSON until timeout. Critical for debugging HMR — no other way to see fanout from outside |
| `af preview render <host> <route> --trace` | Render with structured timing trace — compile ms, render ms, executor cold/warm, cache hit/miss |

### `af doctor` — environment sanity

One command, multiple checks, JSON report:

```
{
  "checks": [
    { "id": "credentials.account_id", "ok": true },
    { "id": "credentials.api_token", "ok": true, "scopes": [...] },
    { "id": "credentials.token.r2_write", "ok": true },
    { "id": "credentials.token.workers_edit", "ok": true },
    { "id": "credentials.token.do_edit", "ok": true },
    { "id": "plan.worker_loader", "ok": true, "plan": "paid" },
    { "id": "framework.cli_version", "ok": true, "version": "0.1.0" },
    { "id": "framework.libs", "ok": true, "host_cloudflare": "0.1.0" },
    { "id": "state.dir_exists", "ok": true, "path": "tests/e2e/.state/abc123/" }
  ],
  "ok": true
}
```

The agent runs `af doctor` first when something's failing
unexpectedly. Quickly localises whether the issue is environmental
(credentials, plan tier) or logical.

### `af exec` — ad-hoc REST call

For cases where there's no specific verb (one-off API exploration,
debugging an undocumented endpoint):

```
af exec GET /accounts/<id>/workers/scripts/<n>
af exec POST /accounts/<id>/r2/buckets/<n>/objects --body @file.bin
```

Auth is auto-attached; output is the raw response. Useful when
investigating an unexpected Cloudflare behavior before deciding
whether to add a dedicated verb.

## Output format

**Default — JSON on stdout, progress on stderr:**

```bash
$ af preview info my-site
{"result":{"fileCount":12,"directoryCount":3,"totalBytes":48291,"hmrConnections":1,"currentDeploy":null},"elapsedMs":143}
```

**Errors — structured:**

```bash
$ af preview cat missing-host /index.astro
{"error":{"code":"HOST_NOT_FOUND","message":"no host named 'missing-host' for sha=abc123","context":{"name":"missing-host","sha7":"abc123","stateDir":"tests/e2e/.state/abc123/"}}}
$ echo $?
1
```

**Human mode:**

```bash
$ af preview info my-site --human
my-site (preview)
  files:        12
  directories:   3
  total bytes:  48,291
  HMR clients:   1
  current:      none
  elapsed:      143ms
```

**Stable error codes:** documented in
`packages/astroflare-cli-lib/src/errors.ts`. Adding new codes is
non-breaking; renaming or repurposing is breaking.

## Agent debugging workflows (acceptance recipes)

These are the workflows the CLI must support end-to-end. Each is a
test in `tests/e2e/cli-workflows.spec.ts`.

### Debug a Mode A render failure

```bash
af provision-host preview foo
af preview write foo /src/pages/index.astro @broken.astro
af preview render foo /                          # → 500 with stderr
af logs foo --since 1m                           # see compile error
af preview cat foo /src/pages/index.astro        # confirm what's in workspace
af preview write foo /src/pages/index.astro @fixed.astro
af preview render foo /                          # → 200
af destroy-host foo
```

### Verify a Mode A HMR roundtrip

```bash
af provision-host preview bar
af preview hmr-tail bar --timeout 30s &           # dump WS messages
af preview write bar /src/pages/index.astro @v1.astro
                                                  # tail prints { type: "update", trigger: "/src/pages/index.astro", ... }
af destroy-host bar
```

### Debug a Mode B deploy mismatch

```bash
af deploy ./fixture --to baz --prefix sites/abc/
af snapshot list baz --prefix sites/abc/         # see new snapshot, marked current
af snapshot show baz <hash>                      # list routes
af snapshot cat baz <hash> /index               # read served HTML
af logs baz --since 1m                           # see deploy ceremony events
```

### Verify a Mode B rollback

```bash
af deploy ./v1 --to baz                          # → snapshot hash A
af deploy ./v2 --to baz                          # → snapshot hash B; B current
af snapshot list baz                             # confirm B current, A retained
af rollback A --to baz                           # flip to A
af snapshot current baz                          # → A
```

### Diagnose an environment problem

```bash
af doctor                                         # JSON report of every check
                                                  # ok: false for plan.worker_loader
                                                  # context: { plan: "free", required: "paid" }
```

## What lands

### `@astroflare/cli` — entrypoint reshape

- Verb dispatch refactor: nested verbs (`af preview <sub>`,
  `af snapshot <sub>`) instead of one flat list.
- Output formatter: every verb returns a `{ result }` object; the
  formatter handles `--human` / `--quiet` / default-JSON.
- Error formatter: every thrown `AstroflareCliError` (new class)
  serialises to `{ error: { code, message, context } }`.
- `printUsage` is generated from a verb table, not hand-written.

### `@astroflare/cli-lib` — library expansion

For every new CLI verb, a corresponding library function the e2e
suite uses directly. New modules under `commands/`:
- `preview-files.ts` (list / cat / write / rm)
- `preview-graph.ts`
- `preview-render.ts`
- `preview-hmr-tail.ts`
- `snapshot-list.ts` / `snapshot-show.ts` / `snapshot-cat.ts` / `snapshot-diff.ts`
- `logs.ts` (wrangler tail wrapper)
- `doctor.ts`
- `exec.ts`

Plus an `errors.ts` defining `AstroflareCliError` + the stable code
catalog.

The `state.ts` module's `listFixtures` / `inspectFixture` /
`statusReport` get reshaped to handle all three state kinds
(`fixture`, `preview`, `stack`) — fixes the silently-skipped bug.

### Reference host fixtures expose introspection

The Phase 26 preview host and Phase 26b deploy host pick up the
diagnostic endpoints these CLI verbs hit:

- Preview host's SiteDO RPC: `listFiles()`, `readFile(path)`,
  `removeFile(path)`, `graphSnapshot()`, `workspaceInfo()`.
  Routed through the host's worker as `/_aflare/preview/*`.
- Deploy host's worker: `/_aflare/snapshots`, `/_aflare/snapshots/<hash>`,
  `/_aflare/snapshots/<hash>/<route>`.

These are reference-fixture endpoints, not framework-mandatory.
Hosts that want the same introspection in production can copy them;
hosts that don't, omit them. Astroflare exports the request handlers
as composable helpers (`createPreviewIntrospectionHandler`,
`createSnapshotIntrospectionHandler`) so a host integrates them with
one line if they want.

### Test coverage (per layer)

| Layer | What's tested |
|---|---|
| A — Node | Each `cli-lib` command against mocked-fetch; output formatter; error serialisation; `state.ts` reshape |
| B — workerd | Reference host introspection RPC inside a real DO |
| C — Miniflare | Full workflow: provision → write → render → graph → cat → rm → destroy |
| D — e2e | `tests/e2e/cli-workflows.spec.ts` — five debugging workflows above run against real Cloudflare |

## Migration strategy

Mostly additive — most existing verbs keep working. Two breaking
output changes:

1. **Default output is JSON.** Existing scripts that parsed the
   prose output will break. Mitigation: scripts add `--human` to
   match prior behaviour, or migrate to JSON parsing.
2. **`provision-preview` / `provision-stack` / `upload-files` /
   `deploy-static`** — already going away in Phase 26 / 26b.
   Replaced here by `af provision-host` / `af deploy`.

Order:
1. Land error class + JSON formatter + verb-table dispatch (no new
   verbs yet — just reshape existing surface).
2. Fix `list` / `inspect` / `health` for stack + preview state.
3. Add Mode A introspection verbs (preview files / cat / write / rm
   / graph / info / hmr-tail).
4. Add Mode B introspection verbs (snapshot list / show / cat / diff
   / current).
5. Add `doctor`, `logs`, `exec`.
6. Add `tests/e2e/cli-workflows.spec.ts` — the agent debugging
   recipes as live tests.
7. Update CLAUDE.md's "Cloudflare CLI (`af`)" section to reflect the
   new verb taxonomy.

Each step ends green.

## Acceptance signals

- Every Astroflare runtime state (workspace files, module graph,
  HMR connections, snapshots, current pointer) is reachable through
  an `af` verb.
- Every state-mutating verb has a read-back counterpart.
- Five agent-debugging workflows pass on real Cloudflare.
- `af doctor` runs in <2s and identifies the four most common
  failure modes (missing credentials, wrong plan tier, stale state,
  Cloudflare API outage).
- The agent (in subsequent sessions) can debug a Mode A or Mode B
  failure using only `af` verbs — no ad-hoc `curl` or `fetch`
  scripts.
- All output is JSON-parseable by default; `--human` opts into
  pretty mode.
- Stable error code catalog documented in `errors.ts` with at
  least 15 codes covering the common failure surface.

## Carve-outs

- **Performance profiling beyond simple timings.** Use Cloudflare's
  analytics dashboard for cold-start histograms, p95 latency
  distributions. CLI exposes per-call timings (`elapsedMs`,
  `compileMs`, `renderMs`) — that's the budget.
- **Multi-account ops.** One `CLOUDFLARE_ACCOUNT_ID` per shell.
  Hosts running across accounts call `af` with different env vars.
- **Custom auth flows beyond bearer.** Account-level decision; the
  CLI assumes a single API token from `CLOUDFLARE_API_TOKEN`.
- **`af watch`-style continuous-deploy mode.** Useful but not
  blocking. Add when a real workflow demands it.
- **Per-token source map inspection.** Out of CLI scope.

## Out of scope

- New framework features. CLI surface only.
- Changes to the reference host fixtures' production endpoints
  (only their introspection endpoints land here).

## Order rationale

Sequencing decision: this phase lands **after** Phase 26 + 26b and
**before** Phase 27 (parity) and 24b (release).

- After 26 / 26b — the new verbs speak the post-North-Star library
  shape (`Site`, `Snapshots`, in-DO coordinator). Building them
  against the pre-refactor shape would require an immediate rewrite.
- Before Phase 27 — when the parity test fails (and it will,
  somewhere, the first run), the agent will need exactly these
  introspection commands to localise the divergence. Doing 27
  before 26c means writing ad-hoc fetch scripts for each debugging
  iteration.
- Before Phase 24b — the release-readiness checklist (publish, docs,
  soak, secret hygiene) benefits from `af doctor` being available
  for users who hit setup issues. It also benefits from the JSON
  output schema being stable (a documented public surface).

Updated phase queue: **26 → 26b → 26c → 27 → 24b**. Estimated
effort: 26c is the largest of the three refactor phases (~3 days)
because it's surface-area-heavy. The mechanical work
(verb-by-verb implementation against existing library functions)
parallelizes well if needed.
