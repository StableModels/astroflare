# Phase 16 — Hydration runtime + island plumbing

**Goal:** real client-side islands. The compiler emits proper
`<astro-island>` markup for `client:*` directives instead of the
Phase 2 placeholder comment. A browser-side runtime defines the
custom element and triggers hydration on `load` / `idle` / `visible` /
`media`. The preview server serves the runtime + compiles user
island sources on demand.

**Status:** done. **599 tests / 52 files / 6 pools all green** (was
574 at end of Phase 15a).

## What landed

### Compiler: `$island` emit + frontmatter import tracking

`emitComponent` no longer emits `$hydrationMarker(...)` (a comment) for
`client:*`. It emits a real `await $island(opts, ssrCallback)` call. To
populate the URL the hydration runtime fetches, the emitter parses the
*hoisted* `import` statements out of the frontmatter into a name → spec
map, available via `EmitContext.islandImports`:

```ts
{
  componentName: "Counter",
  componentSpec: "../components/Counter.tsx",
  importerPath: "/src/pages/index.astro",
  directive: { mode: "load" },
  props: { count: 1 }
}
```

The SSR callback is `null` for `.tsx` / `.jsx` imports (React-style
components — our jsx-runtime doesn't support hooks at SSR time, so
trying to render them is worse than rendering an empty placeholder)
and `async () => $renderComponent(...)` for `.astro` / `.md` / `.mdx`
imports (Astroflare components SSR cleanly through the existing
renderer).

`RUNTIME_SYMBOLS` and `BUNDLE_RUNTIME_SYMBOLS` both pick up `$island`
so the bundle's outer scope provides it.

### Runtime: `$island` server helper

`packages/astroflare-runtime/src/internal.ts` — produces the
`<astro-island>` markup:

```html
<astro-island uid="ab12cd34"
              component-url="/_aflare/island?path=%2Fcomponents%2FCounter.tsx"
              component-name="Counter"
              client:load>
  <script type="application/json" data-aflare-props>{"count":1}</script>
  <!-- SSR'd content here, when ssrCallback was provided -->
</astro-island>
```

Notable details:

- `uid` is `crypto.randomUUID().replace(/-/g, "").slice(0, 8)` —
  unique within a page render, used by tooling that wants to find a
  specific island in the DOM.
- `componentSpec` resolves against `importerPath` via a tiny POSIX
  resolver baked into the helper (no Node `path` import — the
  runtime works under workerd).
- The props JSON is HTML-defanged (`</script>` → `<\/script>`,
  `<!--` → `<\!--`) so embedded HTML inside props can't terminate
  the surrounding `<script>` block.
- When `ssrCallback` throws (component reference undefined because
  the bundler stripped a TSX import), the island wraps an empty
  body. The client mounts fresh — equivalent to `client:only` for
  React components, by design until Phase 16b.

9 unit tests cover the surface: shape, URL resolution, SSR success +
failure, media-query attribute, JSON defang, attribute escaping.

### Hydration client (`hydration-client.ts`)

The `<astro-island>` custom element — defined by `registerAstroIsland()`,
which the preview / deploy server's auto-injected
`<script src="/_aflare/hydration.js">` calls. All four directives:

- `client:load` / `client:only` — `queueMicrotask(hydrate)`
- `client:idle` — `requestIdleCallback(hydrate, {timeout: 2000})`,
  `setTimeout(..., 200)` fallback
- `client:visible` — `IntersectionObserver` until intersecting,
  immediate-fallback when IO unavailable
- `client:media` — `matchMedia(query)`; immediate if `matches`,
  otherwise listen for `change`

Hydration:
1. Read props from `<script type="application/json" data-aflare-props>`.
2. Remove the props script (so frameworks don't try to hydrate it
   as DOM).
3. `await import(componentUrl)` — dynamic-import the bundle.
4. Call `module.mount(island, props)` (or `module.default(...)`).

The class is **defined lazily inside `registerAstroIsland`** so
`HTMLElement` (browser-only) doesn't crash module-load in Node test
suites that import `@astroflare/runtime` from the index.

`HYDRATION_CLIENT_SOURCE` is a string constant containing the same
runtime, hand-translated into plain ES2020 without TS or private
fields. The preview / deploy server serves this verbatim — same
pattern Phase 5 uses for `HMR_CLIENT_SOURCE`.

8 happy-dom tests cover registration, scheduler routing
(`requestIdleCallback`, `IntersectionObserver`, `matchMedia` stubbed),
and the `connectedCallback` idempotence guard.

### Preview server: hydration + island routes

Two new routes:

- `GET /_aflare/hydration.js` — returns `HYDRATION_CLIENT_SOURCE` as
  ESM with a 5-minute cache header. Same content for the lifetime
  of a runtime version.
- `GET /_aflare/island?path=<workspace-path>` — reads the source
  file from `host.storage`, runs `.ts` / `.tsx` / `.jsx` / `.mts`
  through `@astroflare/compiler/ts` (esbuild-wasm), passes through
  `.js` / `.mjs` verbatim. Returns ESM with an etag pinned to the
  source's content hash.

Hydration script auto-injection: the preview server's render path
checks `result.html.includes("<astro-island")` and inserts a
`<script type="module" src="/_aflare/hydration.js"></script>` tag
into the page before the HMR script. Pages without islands stay
clean.

6 integration tests cover both routes (hydration source check,
.tsx compile, missing-source 404, unsupported-extension 415, end-
to-end island markup in rendered HTML, no-injection on island-free
pages).

## Numbers

- **599 tests / 52 files / 6 pools** all green.
- 25 new tests since Phase 15a:
  - `astroflare-runtime/src/internal.test.ts` — 7 new `$island`
    tests
  - `astroflare-runtime/src/hydration-client.test.ts` — 8 new
    happy-dom tests
  - `astroflare-compiler/src/astro/emitter.test.ts` — 4 new emit
    tests covering the import-tracking + SSR-callback decision
  - `astroflare-preview/src/preview-server.test.ts` — 6 new
    integration tests for the `/_aflare/hydration.js` and
    `/_aflare/island` routes + island markup
- Framework boundary still holds.

## Surprises

- **`HTMLElement` doesn't exist outside the browser.** The first
  cut of `hydration-client.ts` declared `class AstroIsland extends
  HTMLElement` at module scope. `astroflare-runtime/src/index.ts`
  re-exports it; loading that index in a Node test
  (`index.test.ts`, the placeholder version-export check) crashed
  on `class … extends HTMLElement` because `HTMLElement` is
  undefined. Fix: build the class lazily inside
  `registerAstroIsland()` so the `extends HTMLElement` lookup
  happens only when called (in the browser, where `HTMLElement`
  resolves).

- **The bundle's runtime symbol list is two places.** Adding
  `$island` to the compiler's `RUNTIME_SYMBOLS` made the emitter
  call it, but the integration test failed with
  `$island is not defined`. The bundle's outer scope imports a
  *separately maintained* `BUNDLE_RUNTIME_SYMBOLS` list in
  `astroflare-preview/src/bundle.ts`. Both have to include the
  symbol. The split is historical (the emitter ships its own
  list because it's used outside the bundler too); a follow-on
  cleanup would unify them. Worth flagging.

- **esbuild's `export function X` normalisation.** A `.tsx` island
  source like `export function mount(el, props) {…}` comes back
  from esbuild's TS-strip as `function mount(...) {...}; export {
  mount };`. Same shape that bit Phase 14's MDX tests. Tests now
  assert on the normalised form.

- **`crypto.randomUUID` works in workerd + Node + browsers.** The
  `$island` UID can use `globalThis.crypto.randomUUID()` in every
  environment we care about. No polyfill needed.

- **happy-dom's IntersectionObserver / matchMedia / requestIdleCallback
  aren't built in.** The hydration-client tests stub them on
  `globalThis` per-test. `vi.restoreAllMocks()` doesn't clean
  up assignments made directly on `globalThis`; we explicitly
  `delete` them in the `finally` of each test.

## What did NOT land in this run (and why)

- **React adapter.** The plan called for "React integration via
  esbuild-wasm JSX." Phase 16 ships the framework-agnostic
  plumbing — the user's island module just has to export a
  `mount(element, props)` function. Wrapping React (so a `.tsx`
  with `export default Counter` automatically gets bundled with
  `ReactDOM.createRoot` glue) is Phase 16a. The hold-up: bundling
  React + ReactDOM into the per-island JS requires either
  bundling it with esbuild-wasm at request time (slow) or
  shipping a pre-bundled chunk + import map (cleaner but more
  infra). Neither is hard; both are out of MVP.

- **React SSR with hooks.** Same root cause — we don't have React
  on the server. SSR rendering of a React component that uses
  `useState` / `useEffect` would explode. `.tsx` islands today
  emit a no-SSR (empty placeholder) island and rely on
  client-side mounting only. `.astro` / `.md` / `.mdx` islands
  do get SSR'd. Phase 16b: bundle React DOM Server into the SSR
  runtime (or use ReactDOMServer's static streaming API).

- **`client:only` as a distinct directive.** Per the plan,
  deferred to Phase 17. The hydration runtime already treats
  `only` like `load` (immediate hydrate, no SSR), so the
  difference is currently skin-deep — `client:only` is what
  every `.tsx` island already does because the SSR callback is
  null. Phase 17 will formalise the distinction and add
  fallback content support.

- **Per-island deploy-time bundling.** The plan called for
  `/site/<deployHash>/_islands/<chunk-hash>.js`. The deploy
  pipeline (Phase 15a) doesn't yet pre-bundle islands; islands
  go through the live `/_aflare/island` route in production too.
  Pre-bundling shaves a per-request compile; not blocking for
  correctness. Phase 16a + Phase 17 territory.

- **Shared chunk for React.** Each island bundle would re-include
  React if we shipped a React adapter today. A shared `react.js`
  chunk plus import-map plumbing is an obvious next step but
  doesn't move the working-dance forward.

- **Hydration overlay / error reporting.** A failed hydration
  surfaces as `console.error` only. A devtools-style overlay
  fits with Phase 19's quality gate work.

- **Custom directive registry.** Astro lets users add their own
  client-side directives. We hard-code the four standard ones.
  Adding a registry is straightforward when there's demand.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm test` — **599 tests across 52 files, all 6 pools green**.
- The `$island` emit shape is content-addressed-stable: identical
  source produces identical island UIDs across runs (verified by
  a deterministic compileAstro cache key).
- Framework boundary check — `cloudflare:workers` and
  `@cloudflare/*` imports stay inside `host-cloudflare`.
- Acceptance §3 (Tier 2): a `.astro` page can include
  `<X client:load />` and the rendered HTML carries
  `<astro-island>` markup with the right props + URL. Verified
  in the new preview-server integration test.

## What the next phase starts from

Phase 17 (polish — view transitions, prefetch, RSS, sitemap)
inherits a working island system. View transitions that snapshot a
page's DOM need to interact with `<astro-island>` (so an island
hydrated on page A doesn't lose state when navigating to page B);
the lifecycle is well-defined enough now to plug those rules in.

Phase 16a (React adapter) is parallel work — it adds an automatic
mount wrapper for `.tsx` files that have a default export, plus
pre-bundles React + ReactDOM into the island artifact. The
framework-agnostic `mount(el, props)` contract from Phase 16
stays load-bearing.

Phase 16b (React SSR with hooks) is the last big interactivity
gap. Bundling React DOM Server into the SSR runtime and routing
`.tsx` SSR through it gets the FOUC-free hydration story
working end-to-end.
