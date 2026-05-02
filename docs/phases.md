# Phase tracker

Each phase ends with a green test suite, a demo, and a written retrospective.
The retrospective informs the next phase's planner.

## Phase 0 — Repo, tooling, CI

**Status:** done.

- pnpm workspaces + TypeScript project references + Vitest + Biome.
- CI workflow lints, typechecks, and runs the full test suite on every PR.
- Per-package `tsconfig.json` extends `tsconfig.base.json`; root `tsconfig.json`
  references each package so `tsc -b` builds the whole workspace.

**Deferred to a later iteration:**

- `vitest-pool-workers` (Layer B host tests against workerd).
- Miniflare integration test harness (Layer C end-to-end).
- These come online when `@astroflare/host-cloudflare` gains substantive code
  to test (currently just an entrypoint stub).

**Retrospective notes for Phase 1:** the framework boundary is asserted via a
grep-based test rather than an import-graph linter — cheap, robust, and matches
acceptance criterion #5 in the brief.

## Phase 1 — Host capability interfaces + in-memory substrate

**Status:** done.

Delivered:

- `@astroflare/core/src/types.ts`: the five interfaces (Storage, Executor,
  Coordinator, Transport, Clock) plus Logger, Host, AstroflareConfig, ModuleNode,
  HmrMessage, Subscription.
- `@astroflare/core/src/app.ts`: `createApp({ config, host }) -> AstroflareApp`.
  `app.fetch()` is a 501 stub until Phase 3.
- `@astroflare/core/src/hash.ts`: `contentHash`, `combinedHash` (SHA-256 hex
  truncated to 16 chars per §9.4 of the brief).
- `@astroflare/preview/src/module-graph.ts`: `ModuleGraph` with `set`, `get`,
  `delete`, `invalidate`, `audit`. Tombstones nodes that still have importers
  (so a deleted dep correctly invalidates its importers); GCs orphan
  placeholders.
- `@astroflare/test-utils`: `MemoryStorage`, `MapCoordinator`,
  `InProcessExecutor`, `FixedClock`, `CapturingLogger`, `NullTransport`,
  `createTestHost()`.

**Tests (Layer A only — Layer B/C land with Phase 3):**

- `memory-storage.test.ts`: 7 tests — round-trip, ENOENT, stat hash stability,
  cache subspace isolation, glob (`*`, `**`, `{a,b}`).
- `map-coordinator.test.ts`: 7 tests — graph CRUD, pub/sub fan-out,
  unsubscribe, file-change broadcasts the correct invalidation set.
- `inproc-executor.test.ts`: 10 tests — runOnce, virtual require for
  sub-modules, runCached factory invocation count, isolate freshness, error
  propagation, async tasks, default/run export shapes.
- `module-graph.test.ts`: 6 unit + 4 property tests over random edit sequences;
  asserts `audit() === []` after every edit and that `invalidate(target)`
  matches a reference reverse-edge BFS.
- `boundary.test.ts`: greps the framework src trees for `cloudflare:` and
  `@cloudflare/` imports; both must be empty.
- `app.test.ts`: createApp + integration hook execution + contentHash sanity.

**Surprises that informed the design:**

- A naïve `delete(path)` that fully drops the node loses back-edges from
  importers, so `invalidate(path)` after a delete returns `{}` instead of the
  importer closure. The fix is to tombstone nodes that still have importers.
- A symmetric problem in `set`: when a node drops a dep, the dep's placeholder
  becomes orphaned and shows up as a stray node in the graph. The fix is to GC
  uncompiled placeholders whose importer count hits zero. Property tests caught
  both, which is exactly what they're for.

## Phase 2 — `.astro` compiler

**Status:** baseline done. Tier 0 grammar covered apart from TS frontmatter
type-stripping (deferred to a follow-up that adds esbuild-wasm).

Delivered:

- `@astroflare/compiler/src/astro/parser.ts` — pure-JS recursive-descent parser
  with full source-position errors. Handles frontmatter, elements, components
  (capitalised tags + member access), self-closing/void elements, attributes
  (static, expression, shorthand, spread, boolean, unquoted), interpolations
  with balanced-brace expression scanning that respects strings, template
  literals (with nested `${}`), and line/block comments, slot elements with
  fallback content, raw `<style>` / `<script>` blocks, doctypes, and HTML
  comments.
- `@astroflare/compiler/src/astro/emit.ts` — emitter producing an ESM module
  whose default export matches Astro's `(result, props, slots) ⇒ Promise<string>`
  ABI. Frontmatter `import`/`export ... from` declarations are hoisted to the
  module top so ESM resolution works; the rest of the frontmatter becomes the
  body of the render function (so destructured props are in scope).
  `set:html` bypasses escaping; `is:raw` skips child interpolation; component
  children are grouped by `slot="<name>"` into named slot functions; `<slot
  name="x">fallback</slot>` compiles to `result.renderSlot($$slots, "x",
  fallback)`.
- `@astroflare/runtime/src/render.ts` — `escape`, `attr`, `attrs`,
  `renderComponent`, `renderSlot`, `createResult`. `attr` follows Astro's
  ergonomics: `false`/`null`/`undefined` omit the attribute entirely, `true`
  emits a boolean attribute. `attrs` iterates an object through `attr`.
- `@astroflare/compiler` Tier 0 public API: `compileAstro(source, opts) →
  { ast, code }`.

Tests (Layer A, 62 added — 104 in the workspace total):

- `packages/astroflare-compiler/test/parser.test.ts` — 24 tests covering
  frontmatter (positive and unterminated), element classification (HTML vs
  component vs slot), attributes (every shape), interpolation balance
  (including nested object literals, template literals with `${...}`, strings
  containing `}`), raw blocks, doctypes, and comments. Negative tests assert
  source-position errors with a caret-ed snippet.
- `packages/astroflare-compiler/test/emit.test.ts` — 13 tests pinning the
  emitted output for each grammar feature.
- `packages/astroflare-compiler/test/render.e2e.test.ts` — 11 tests that
  compile an `.astro` source, write the emitted ESM to a tmpdir, `import()`
  it, render with a real `result`, and assert the produced HTML byte-for-byte.
  Includes a multi-file fixture: a parent component imports a compiled child
  and renders it through the child's `<slot />`.
- `packages/astroflare-runtime/test/render.test.ts` — 14 tests for the runtime
  helpers in isolation.

**Surprises that informed the design:**

- Astro's `(result, props, slots)` ABI is genuinely DI-shaped — the runtime is
  injected at every call site, which means tests can construct an isolated
  `result` per render without monkey-patching anything. Worth keeping when we
  ship streaming.
- The interpolation expression scanner has to know about JS lexical
  syntax — strings, template literals, regex-like comments — to pair `{` and
  `}` correctly. A naïve depth counter falls over on `{ a: '}' }`. The scanner
  in `parser.ts` is intentionally narrow (no full ECMAScript parse): it tracks
  brace depth while recognising string / template-literal / comment regions.
- Hoisting `import` declarations out of the frontmatter is required for ESM
  resolution but means tests have to write to a real file path, not a `data:`
  URL — `data:` URLs don't resolve relative imports.

**Deferred to follow-ups:**

- TypeScript type-stripping in frontmatter (esbuild-wasm).
- JSX-style element children inside `{...}` expressions
  (`{items.map(i => <Foo />)}` — currently you write the outer markup as a
  string).
- `define:vars`, `class:list`, `style` object form.
- Client directives (`client:load`, etc.) — parsed today as plain attributes;
  hydration markers come with Phase 8.

## Phase 3 — Server runtime + first end-to-end render

**Status:** not started. The ABI and `createResult()` already exist; Phase 3
wires `Astro.props/params/request/url/redirect/cookies`, layouts, file-based
routing, and the preview server's request → compile → render → response path.

## Phases 4 – 9

See the design brief, §7. Each phase ends with green tests on both hosts,
a demo, and a retrospective in this file.
