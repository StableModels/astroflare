# Phase 28 — Documentation pass + reference-fixture promotion

**Goal:** make Astroflare consumable. The architecture lands at the
public API surface in Phases 26 / 26b / 26c; this phase builds the
documentation users need to integrate it, and promotes the reference
fixtures from `tests/e2e/fixtures/` to a top-level `examples/`
location so users can clone a working starting point.

**Status:** planned. Substantial human-driven writing; this doc
captures the structure + the load-bearing pieces, not finished prose.

## Why now

The published API surface stabilized as of the post-Phase-26 hard
cuts. Users (vibe-coding hosts, internal teams, eventually OSS
adopters) need a clear "how do I use this?" path. Today that path is
implicit in the phase docs + the reference fixture code; not
discoverable.

## What lands

### `examples/preview-host/` (promoted from `tests/e2e/fixtures/preview-host-ref/`)

Mode A reference host. Same code; new home; a few real-world
additions:

- `package.json` declares public deps (`@astroflare/host-cloudflare`,
  `@astroflare/site-workspace`, `@cloudflare/shell`,
  `@cloudflare/workers-types`).
- `README.md` walks a user through:
  - "What this is" — a SiteDurableObject + worker pattern they
    can copy.
  - "How to deploy" — `node build.mjs && wrangler deploy`.
  - "How to write content" — the POST `/_aflare/site/file` shape;
    the HMR endpoint; the diagnostic endpoints.
  - "How to extend" — multi-site routing, custom auth on the file
    endpoint, custom `Site` adapters.
- `wrangler.jsonc` in the published shape (DO + R2 + Worker
  Loader + DEPLOY_TOKEN).
- `files/` minimal Astro project users can edit to learn the loop.

### `examples/deploy-host/` (promoted from `tests/e2e/fixtures/deploy-host-ref/`)

Mode B reference host. Same shape:

- `package.json` declaring `@astroflare/build` +
  `@astroflare/host-cloudflare`.
- `README.md`:
  - Multi-environment / multi-site pattern (the `prefix` parameter).
  - How `af deploy` produces snapshots and flips `current`.
  - Custom cache-header policies via `cacheHeaders` callback.

### Astroflare docs site (`docs/site/` or `apps/docs/`)

A structured documentation tree. Suggested layout (build-tool
agnostic — pick a static-site tool when the work starts):

```
docs/
  overview.md                 — what Astroflare is
  getting-started.md          — pick a mode, deploy in 5 minutes
  architecture/
    boundary.md               — the North Star, framework vs host
    interfaces.md             — Site, Cache, Snapshots, Coordinator
    diagrams/                 — boundary diagrams from CLAUDE.md
  modes/
    preview.md                — Mode A walkthrough referencing examples/preview-host/
    deploy.md                 — Mode B walkthrough referencing examples/deploy-host/
    parity.md                 — when to use which; what's shared
  guides/
    multi-site.md             — prefix-based partitioning
    multi-env.md              — dev/staging/prod buckets
    custom-site-adapter.md    — implementing Site against a non-Workspace backend
    custom-auth.md            — gating /_aflare/site/file
    hmr.md                    — protocol shape + browser integration
  cli/
    overview.md               — `af` agent ops surface
    verbs.md                  — every verb with JSON output schema
    error-codes.md            — the CLI_ERROR_CODES catalog
  reference/
    api/
      core.md                 — Site, Cache, Snapshots, etc.
      host-cloudflare.md      — createCoordinator, createPreviewHandler, R2Snapshots, etc.
      build.md                — buildSite, deploySite, createSnapshotHandler
      site-workspace.md       — WorkspaceSite
  changelog.md                — release notes
  contributing.md             — for repo contributors
```

### API reference (auto-generated from TS types)

Run a doc generator (typedoc or api-extractor) over the public
exports of each `@astroflare/*` package. Output lands under
`docs/reference/api/`. Targets:

- `@astroflare/core` — Site, Cache, SiteChangeEvent, Snapshots,
  SnapshotEntry, SnapshotSink, Host, Coordinator, Executor, etc.
- `@astroflare/host-cloudflare` — `createCoordinator`,
  `createPreviewHandler`, `acceptHmrSocket`, `SqlCache`,
  `createWorkerdExecutor`, `R2Snapshots`, `R2SnapshotSink`.
- `@astroflare/build` — `createSnapshotHandler`,
  `LocalSite` (under `/node`), `buildSite`, `deploySite`.
- `@astroflare/site-workspace` — `WorkspaceSite`.
- `@astroflare/cli` — every verb's input/output schema.

### Migration / operational guides

- **`docs/guides/host-integration.md`** — a complete walkthrough
  for a host engineer: "I want to embed Astroflare in my vibe-coding
  app." Covers SiteDurableObject construction, the change pipeline
  wiring (Workspace.onChange → coordinator.notifyChanged), HMR
  endpoint, error handling, secret hygiene.
- **`docs/guides/upgrade-policy.md`** — the backwards-compat
  declaration from `phase-24b-release-readiness.md` made
  user-facing. What's stable, what's experimental, semver shape.

## Test coverage

The docs themselves don't get tests, but the example walkthroughs do
get a smoke check:

- `tests/docs-smoke/getting-started-mode-a.test.ts` — runs the
  Mode A walkthrough commands literally; asserts the deployed URL
  serves the expected HTML.
- Same for Mode B.

These run only when credentials are sourced.

## Migration of existing fixtures

`tests/e2e/fixtures/preview-host-ref/` and `deploy-host-ref/` get
moved to `examples/`. `tests/e2e/global-setup.ts` and the build
scripts shift their paths. `pnpm-workspace.yaml` registers the new
locations. State files (`tests/e2e/.state/<sha7>/*.preview.json`,
`*.stack.json`) keep their format.

## Acceptance signals

- A user reading `examples/preview-host/README.md` can clone the
  dir into their repo, run `pnpm install && node build.mjs &&
  wrangler deploy`, and have a working preview host on real
  Cloudflare.
- Same for `examples/deploy-host/`.
- The docs site builds cleanly and links to every public symbol.
- The "Get started" path takes <5 minutes from clone to served HTML.

## Carve-outs

- **Docs hosting.** Whether the site lives at `astroflare.dev` /
  `astroflare-docs.pages.dev` / inside the GitHub repo's wiki is a
  process decision, not in this plan.
- **Internationalised docs.** English only for v0.1.0.
- **Search.** Static site can ship without Algolia / similar; add
  later if doc volume warrants.
- **Live playground / CodeSandbox-style embed.** Interesting but not
  blocking. Defer.

## Order rationale

Lands after Phase 26d (so the docs can claim verified debugging
workflows) and before/alongside Phase 24b release readiness (the
docs site is one of the explicit Phase 24b gates). Conceptually
substantial; ~1-2 weeks of focused writing for a v0.1.0-quality
documentation cut.
