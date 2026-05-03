# Deferred-children sweep — Phases 16a / 16b / 20a / 15b + smaller defers

**Goal:** clear every "deferred" child of the main 0–20 phase plan
in one focused pass. Combines five sub-phases of work that the
top-level plan called out as ride-along or follow-up.

**Status:** done. **750 tests / 64 files / 7 pools all green** (was
678 + 2 skipped at end of Phase 20).

## What landed

### Phase 16a — React adapter

`packages/astroflare-runtime/src/react-adapter.ts`. Two pure
surfaces:

- `wrapReactIslandSource(src)` — compile-time wrapper that detects
  a top-level `export default <expr>` (or the esbuild-normalised
  `export { Foo as default }` form) and injects:
  - `import { mountReactIsland as __aflareMount } from "/_aflare/react.js"`
  - `const __aflareDefault = <original expr>;`
  - `export default __aflareDefault;`
  - `export function mount(__el, __props) { return __aflareMount(__aflareDefault, __el, __props); }`

  Sources without a default export pass through unchanged so
  vanilla-JS islands keep working.

- `MOUNT_REACT_ISLAND_SOURCE` — the `/_aflare/react.js` route
  source. Imports React + react-dom/client from esm.sh by
  default (overridable via the route); exports
  `mountReactIsland(Component, el, props)` which calls
  `createRoot(el).render(React.createElement(Component, props))`,
  caching the root on the element so subsequent re-mounts can
  `unmount()` cleanly.

`serveIslandModule` in the preview server runs `wrapReactIslandSource`
on `.tsx` / `.jsx` after esbuild's TS-strip + JSX transform. The
preview-server route table picks up `/_aflare/react.js` alongside
the existing hydration / view-transitions / prefetch routes.

### Phase 16b — React SSR with hooks

`packages/astroflare-runtime/src/react-ssr.ts`. `ssrReactIsland(Component, props)`
dynamically imports `react` + `react-dom/server` and calls
`renderToString`. Exposed under `$ssrReactIsland` (the `$`-prefixed
ABI alias) plus the import-friendly `ssrReactIsland`.

Failure paths (component not a function, missing React,
renderToString throws) log a warning and return empty raw HTML —
the surrounding page still renders, the user sees a console message,
the page falls back to client-only mounting.

The emitter's `ssrCallbackFor` decides per import:
- `client:only` → `null` (skip SSR by directive).
- `.astro` / `.md` / `.mdx` (or unknown source) → `async () => $renderComponent(...)`.
- `.tsx` / `.jsx` → `async () => $ssrReactIsland(name, props)`.

`$ssrReactIsland` is added to both `RUNTIME_SYMBOLS` (compiler
imports) and `BUNDLE_RUNTIME_SYMBOLS` (preview bundler imports);
`internal.ts` re-exports it for ABI cohesion.

`react@18.3.1` + `react-dom@18.3.1` added as devDependencies of the
runtime package so the SSR tests exercise the real React path.

### Phase 20a — Rest of e2e verbs + Astro fixtures

Three new `aflare-e2e` verbs in `tools/aflare-e2e/src/commands/`:

- `inspect <fixture>` — print state JSON.
- `status` — issue HEAD against every provisioned URL, report
  status + latency. Mock-injectable `fetchImpl` for tests.
- `gc` — list orphan workers (live in account but no local state)
  matching the `aflare-e2e-` prefix. `--purge` deletion is left
  for follow-up.

Two new fixtures + e2e specs:

- `tests/e2e/fixtures/basics/` (routes + scoped CSS, two pages) +
  `basics.spec.ts` (gated on `AFLARE_E2E_URL_BASICS`).
- `tests/e2e/fixtures/ssr/` (a `.ts` GET endpoint echoing search
  params) + `ssr.spec.ts` (gated on `AFLARE_E2E_URL_SSR`).

### Phase 15b — Cap'n Web RPC services + `aflare init`

Three new RPC service interfaces in `@astroflare/core`:

- `FsService` — `write` / `read` / `remove` / `stat` for external
  agents (LSP / IDE / dev server) writing into the workspace.
- `LogService` — `event(name, fields)` for spawned isolates to
  surface diagnostics back to the parent.
- `EnvService` — `getSecret(name)` / `listSecretNames()` for
  cross-isolate env access.

In-process implementations in `@astroflare/test-utils`:
- `InMemoryFsService` — wraps a `Storage`, fires optional
  `onWrite` / `onRemove` callbacks (the host wires those into
  `notifyFileChanged` / `notifyFileRemoved`).
- `InMemoryLogService` — buffers events in `events: CapturedLogEvent[]`
  for assertions.
- `InMemoryEnvService` — reads from a frozen `Record<string, string>` /
  `Map`.

`Host` extended with optional `fsService` / `logService` /
`envService` fields. Cap'n Web *wire-protocol* implementation
remains deferred to Phase 15c — these interfaces give the host
package a clean place to plug in real RPC classes when the
agent surface gets fleshed out.

`aflare init <dir>` command in `@astroflare/cli`. Pure-Node file
writes (`fs.writeFileSync`); produces a minimal scaffold:
`aflare.config.json`, `package.json`, `.gitignore`, `src/pages/index.astro`,
`src/pages/about.astro`. `--force` flag overrides existing files;
`--name` / `--site` customise the scaffold output.

### Smaller defers batch

- **i18n** (Phase 18 follow-up):
  - `getLocaleByPath(pathname, config)` — alias for `deriveLocale`
    matching Astro's API name.
  - `getAbsoluteLocaleUrl(locale, path, config, site)` — builds an
    absolute URL.
  - `parsePreferredLocales(acceptLanguage, config)` — parses
    `Accept-Language` into a project-supported, q-ordered list.
  - `Astro.preferredLocale` + `Astro.preferredLocaleList` threaded
    through `SharedRenderContext` → `RenderContext` → `AstroGlobal` /
    `EndpointContext`. The preview server reads
    `Accept-Language` once per request and computes both.
- **Prefetch tap strategy** (Phase 17 follow-up): new
  `data-aflare-prefetch="tap"` triggers fetch on `mousedown` /
  `touchstart` (~80–200 ms earlier than `click`).
- **Auto-built sitemap from routes** (Phase 17 follow-up):
  `buildSitemapFromRoutes(routes, opts)` filters dynamic /
  endpoint routes and produces a path list feeding `generateSitemap`.
  `excludePatterns` regex filter; `collapseIndex` toggle.
- **`Astro.self`** (Phase 10 follow-up): `$renderComponent` now
  binds `self` = the component being rendered, so a component can
  recursively call itself via `<Astro.self ... />`. Top-level
  route renders set `self` to `undefined`.
- **`client:only` distinct directive** (Phase 19 follow-up):
  emitter routes `client:only` islands to `ssrCallback = null`
  regardless of source extension, formalising the contract that
  was previously incidental.

## Numbers

- **750 tests / 64 files / 7 pools** all green (was 678 + 2 skipped
  at end of Phase 20). +72 net tests across the sweep.
- New test files: `react-adapter.test.ts`, `react-ssr.test.ts`,
  `in-memory-services.test.ts`, `init.test.ts`. Test additions to
  `i18n.test.ts`, `sitemap.test.ts`, `prefetch-client.test.ts`,
  `render.test.ts`, `cli.test.ts` (in tools/aflare-e2e),
  `emitter.test.ts`, `preview-server.test.ts`.

## Surprises

- **esbuild normalises `export default function X` to
  `function X; export { X as default };`.** The Phase 16a wrapper
  has to handle both forms — the raw user-authored shape (which the
  preview server sees if the user ships pre-transformed JS) and
  the post-esbuild normalised shape (the common case after `.tsx`
  transform).

- **`MemoryStorage.stat().hash` is the 16-char content-addressed
  id, not a full SHA-256.** Caught a test assertion mismatch in
  `InMemoryFsService.stat`; updated the assertion to match the
  framework convention from `@astroflare/core`.

- **The Phase 17 `<Prefetch />` source string had to grow with the
  tap strategy.** Two surfaces (typed installer + source string)
  doubles the surface area of a change like this. Worth watching:
  if there's a third event handler, it's time to bake a single
  source out of the typed module rather than maintaining both by
  hand.

- **`react@18.3.1` is the right version for Astro fixtures.**
  React 19's API surface changed; pinning to 18.3 keeps the SSR
  path on `renderToString` (legacy sync API) and matches what most
  current Astro projects ship.

## What's still deferred

These remain on the carve-out list:

- **Phase 15c** — actual Cap'n Web wire-protocol `WorkerEntrypoint`
  classes for FsService / LogService / EnvService / ImageService.
  Workflow-orchestrated parallel render fan-out for static
  deploys. `ImageService` production wiring against the Cloudflare
  Images binding. Cross-isolate `getSecret` (threading env via
  TaskBundle context). `aflare deploy --watch`.
- **Phase 16c** — shared-React-chunk strategy with import map so
  multi-island pages don't ship N copies of React. Today's
  approach has every island bundle re-imports from the same
  `/_aflare/react.js`, but the ESM module cache dedupes after
  the first hit.
- **Phase 19b** — differential parity tests vs Astro fixture
  corpus (still requires importing the corpus). Per-token source
  maps from the compiler. Parser-level `is:raw`. Production-deploy
  overlay scrub.
- **Phase 20b** — observe-tier verbs (`logs` / `metrics` / `trace`),
  the rest of the Astro fixture corpus (portfolio /
  framework-react / non-html-pages / middleware / with-mdx /
  hackernews). `--purge` flag for `gc`. Multi-region geographic
  assertions. Custom-domain provisioning.
- **Tier 3 (still explicitly out of MVP)** — `astro:*` integration
  hook API, server islands, server actions, DB integrations,
  sessions. Vue / Svelte / Solid / Lit — opinionated React-only
  cut.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm test` — **750 tests across 64 files, all 7 pools green**.
- Framework boundary check — every new file lives in
  `packages/astroflare-{runtime,core,test-utils,cli,compiler,preview}/` or
  `tools/aflare-e2e/`; nothing reaches into `cloudflare:*` from
  outside `host-cloudflare`.
- The deferred-children list at the bottom of `docs/next-phases.md`
  is now mostly cleared, with the residue carved out into Phase
  15c / 16c / 19b / 20b stubs above.
