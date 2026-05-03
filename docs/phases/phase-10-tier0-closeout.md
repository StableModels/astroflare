# Phase 10 — Tier 0 close-out (`getStaticPaths` + Astro.* finishers)

**Goal:** close the carryovers that the brief lists in Tier 0 but Phase 3
deferred — `getStaticPaths()` for dynamic routes, plus the `Astro.cookies`,
`Astro.locals`, `Astro.slots`, and `Astro.redirect` propagation surface.
Plus the cross-cutting `graphRemove` → `prune` HMR wiring that
`docs/next-phases.md` parked into this phase.

**Status:** done. **424 tests / 38 files / 5 pools all green** (was 378
at end of Phase 2.5b — 46 new tests across the new surfaces).

## What landed

### `getStaticPaths()` — dynamic-route prerender

A `.astro` route can now export `getStaticPaths` from frontmatter; the
build pipeline expands the route into one prerendered HTML output per
returned entry.

```astro
---
export async function getStaticPaths() {
  return [
    { params: { slug: "a" }, props: { title: "Post A" } },
    { params: { slug: "b" }, props: { title: "Post B" } },
  ];
}
const { title } = Astro.props;
const { slug } = Astro.params;
---
<h1>{title}</h1>
```

Three pieces wire this:

1. **Compiler** (`packages/astroflare-compiler/src/astro/emitter.ts`) —
   added `hoistTopLevelExports`. It tokenises frontmatter with brace /
   paren / bracket-depth tracking and string handling, finds top-level
   `export` declarations (`function`, `class`, `const`/`let`/`var`),
   and lifts them out of the component arrow to module scope. Without
   this, `export ... function getStaticPaths` inside the arrow is a
   syntax error.

2. **Bundle wrapper** (`packages/astroflare-preview/src/bundle.ts`) —
   each per-module IIFE now returns `{ default, getStaticPaths? }`
   instead of just `__default`. The route wrapper switches on
   `ctx.kind`: `"paths"` returns the module's `getStaticPaths()`
   result, anything else runs `render(__m_route.default, ctx)`. All
   `__m_<i>` references (the cross-module bindings the bundler rewrites
   `.astro` imports into, plus the wrapper itself) gained a `.default`
   suffix.

3. **Planner** (`packages/astroflare-build/src/planner.ts`) — the bare
   `plan(storage)` form still skips dynamic routes (back-compat for
   existing tests). The new `plan({host, runtimeImport})` form compiles
   the route closure, invokes `host.executor.runOnce(bundle, {kind:
   "paths"})`, and emits one `static-paths` plan per entry. Output paths
   are computed by substituting `[name]` segments with URL-encoded param
   values (`outputPathFor` grew an optional `params` arg).

The deploy pipeline (`@astroflare/build`) calls the new plan form,
hashes both `static` and `static-paths` files into the deploy
fingerprint, and asks `renderForRoutes` to walk both kinds. Each
`static-paths` plan threads its `{params, props}` into `RenderContext`
so `Astro.params` and `Astro.props` see the right values.

### `Astro.cookies` — request parser + response staging

New `CookieJar` class in `@astroflare/runtime/cookies.ts`. Parses
`Cookie` lazily on first read; `set` / `delete` stage `Set-Cookie`
strings the framework merges into the outgoing response.

Astro-shaped surface: `get(name)` returns
`{value, json(), number(), boolean()}` per Astro's docs; `has`, `set`
(with `domain`, `expires`, `httpOnly`, `maxAge`, `path`, `sameSite`,
`secure` options), `delete`, `headers()` (the staged list).

Threaded through `render()` → instantiated per-request → bound into
`SharedRenderContext` so nested `$renderComponent` calls see the same
jar via the AsyncLocalStorage context. The preview server merges
`result.cookies` into the response's `Set-Cookie` header (one append
per staged cookie).

### `Astro.locals` — middleware-set scratch bag

`MiddlewareContext.locals` already existed; `RenderContext` now also
carries `locals?: Record<string, unknown>`. The preview server
captures the same `mwCtx.locals` reference that middleware mutates,
threads it into the render context, and `makeChildAstro` reads it
from the ALS so every nested component sees the same bag. Previously
middleware could set `ctx.locals.user = ...` but pages never saw it.

### `Astro.slots` — imperative slot API

`makeAstroSlots(slotMap)` builds `{has(name), render(name)}`. `render`
flattens the slot to an HTML string (parity with Astro's docs). Each
component sees its own slot map (the second arg of the inner async
function); the wrapping is consistent for both the root component
(via `render()`) and nested components (via `$renderComponent`).

### `Astro.redirect` — Response propagation

A component returning a `Response` (typically `Astro.redirect(...)`)
now short-circuits. Mechanism: `$component`'s wrapper detects
`instanceof Response` and throws a `ResponseSignal` (a small custom
`Error` carrying the response). `render()` catches it and emits a
structured `RenderResult` of `kind: "response"`.

`render()`'s return type widened from `Promise<string>` to
`Promise<RenderResult>`:

```ts
type RenderResult =
  | { kind: "html"; html: string; cookies: readonly string[] }
  | { kind: "response"; status: number; headers: Readonly<Record<string, string>>;
      body: string | null; cookies: readonly string[] };
```

JSON-serialisable so it survives the executor's fetch-shaped RPC
boundary intact (§9.1). The preview server unpacks both kinds; the
build pipeline writes `html` plans to disk and skips `response` plans
with a logged event (Astro emits a meta-refresh HTML or a `_redirects`
manifest entry for static-build redirects — we don't yet, deferred to
Phase 14+ when the asset pipeline lands).

### File-removal → `prune` HMR

`Coordinator.onFileRemoved(path)` snapshots the reverse closure
(transitive importers), removes the graph node, and publishes a
`prune` HMR message naming `[path, ...importers]`. `AstroflareApp`
gained a parallel `notifyFileRemoved(path)` that delegates to the
coordinator. The preview server's HMR pipeline now handles `prune`
messages: it re-discovers routes if any pruned path is under
`/src/pages/`, and clears the cached middleware function if
`/src/middleware.js` is in the prune set.

### Type changes (`@astroflare/core`)

- `AstroGlobal<P, L>` — added `cookies: AstroCookies`,
  `locals: L`, `slots: AstroSlots`. Now generic over the locals
  type (Astro uses `App.Locals` declaration merging; we mirror with a
  generic).
- New interfaces: `AstroCookies`, `AstroCookieValue`,
  `AstroCookieSetOptions`, `AstroSlots`, `RenderResult`.
- `RenderContext<P, L>` — added optional `locals: L`.
- `Coordinator` — added `onFileRemoved(path)`.
- `AstroflareApp` — added `notifyFileRemoved(path)`.

The `$component` ABI widened: `AstroComponent<P>` is now
`(props, slots) => Promise<RawHtml | Response>`. Callers either
flatten as before or detect Response and propagate.

## Numbers

- **424 tests / 38 files / 5 pools** all green.
- 46 new tests since end of Phase 2.5b:
  - `runtime/cookies.test.ts` — 17 tests (parse, encode, options, lifecycle)
  - `runtime/render.test.ts` — 13 tests (cookies/locals/slots/redirect surface
    via render())
  - `compiler/astro/emitter.test.ts` — 4 hoisting tests
  - `build/index.test.ts` — 5 new tests (param substitution, getStaticPaths
    expansion, props threading, redirect skip)
  - `test-utils/map-coordinator.test.ts` — 4 onFileRemoved tests
  - `core/index.test.ts` — 1 notifyFileRemoved test
  - `preview/preview-server.test.ts` — 4 end-to-end (cookie read/write,
    redirect, locals, prune route invalidation)
- Framework boundary still holds (zero `cloudflare:` / `@cloudflare/`
  matches in framework-package `/src` directories).

## Surprises

- **Frontmatter top-level exports are inside an arrow** — the existing
  emitter wrapped the entire frontmatter inside `async ({Astro,...},
  $$slots) => { /* fm */ return $render`...` }`. `export` inside an
  arrow is a syntax error, so until this phase `getStaticPaths` couldn't
  even be authored. The hoister had to extract them out *before* the
  body was injected.

- **Bundle IIFEs grew a shape** — `__m_${i}` used to be the route's
  default export directly. Now it's `{default, getStaticPaths?}` so the
  wrapper can reach for either. Every cross-module reference inside the
  bundler now appends `.default`.

- **Render's return type widened** — `Promise<string>` →
  `Promise<RenderResult>`. The preview server, build pipeline, and the
  workerd-pool e2e tests all consume it; each unpacks the discriminated
  union. Worth it because `Astro.redirect()` from a route was previously
  just emitting `[object Response]` into the HTML.

- **CookieJar must thread through ALS** — child components reach for
  cookies via `getRenderContext()`. Originally I had them flow only
  through `createAstroGlobal` for the root; nested components got a
  `noopCookies()` shim. Fixed by threading `cookies` into
  `SharedRenderContext` so `makeChildAstro` reads the per-request jar.

## What did NOT land in this run (and why)

- **`Astro.self`** — recursive components. Brief lists it as Tier 0
  niche; `docs/next-phases.md` carved it out explicitly. Patterns that
  use it (recursive nav menus etc.) can usually be expressed without it.

- **Build-time redirect emission** — when a route returns a Response in
  static deploy, we log a `build.route.response` event and skip writing
  the file. Astro emits either a meta-refresh HTML or a `_redirects`
  manifest entry; we'll add the choice in Phase 14 when the asset
  pipeline + manifest grow.

- **Markdown getStaticPaths** — the planner short-circuits on
  `route.kind !== "astro"` for dynamic-route expansion. Markdown
  frontmatter has no execution context that could expose
  `getStaticPaths`; full support is a Phase 14 carryover (along with
  named `.md` exports).

- **Cookie-jar headers cross-module visibility** — when a child
  component sets a cookie, the staged headers live on the per-request
  jar (correct), but the ALS read happens on every `makeChildAstro`
  call. If a deeply nested component sets a cookie, then exits, then a
  sibling sets another, the second sees its own jar via ALS — same
  identity, so writes accumulate. ✓ tested in `render.test.ts`. The
  surprise risk would be a cookie set inside a Promise that resolves
  *after* render completes. Not realistic in practice; if it surfaces
  the fix is `await`-ing the Promise rather than the framework changing.

- **`Astro.slots.render(name, args)`** — the second arg is for
  parametric (callback-shaped) slots. Astro components in JS pass the
  args to the slot function; ours don't because our slots are
  `() => unknown` (no args). Adding parametric slots is a small change
  but no real demand for it yet; deferred.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm lint` — green.
- `pnpm test` — **424 tests across 38 files, all 5 pools green**.
- Framework boundary check — zero `cloudflare:` / `@cloudflare/`
  matches in framework packages.
- Tier 0 spec coverage: `getStaticPaths`, `Astro.props/params/request/
  url/site/redirect/cookies/locals/slots` all implemented and
  exercised in tests. (`Astro.self` deferred per next-phases.md.)

## What the next phase starts from

Phase 11 is **TS support throughout** (esbuild-wasm in a Compile DW).
With Tier 0 closed and the executor proven on RenderResult, Phase 11
just needs to add `transformTS(source) → string` and route
`.astro` frontmatter and `.ts` endpoints through it before the
existing pipeline picks them up. The `examples/minimal-blog` fixture
is the obvious smoke test — add a `.ts` endpoint and TS-typed
frontmatter to a page, watch it render.
