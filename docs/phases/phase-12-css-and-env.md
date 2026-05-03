# Phase 12 — Scoped + global CSS, `import.meta.env` substitution

**Goal:** users can drop `<style>` blocks into `.astro` components and
have them automatically scoped to that component's elements; `<style
is:global>` opts out. Plus compile-time `import.meta.env.X`
substitution from the user's config.

**Status:** done. **465 tests / 40 files / 5 pools all green** (was
445 at end of Phase 11).

## What landed

### Parser raw-text mode for `<style>` and `<script>`

Pre-Phase 12 the parser tried to parse CSS braces (`{ color: red; }`)
as Astro expressions, breaking compilation of any `.astro` file that
included a `<style>` block. The parser now treats `<style>` and
`<script>` as raw-text elements per HTML spec: their content is
captured as a single text node, scanned forward to the matching
case-insensitive closing tag.

`<title>` and `<textarea>` (HTML "escapable raw text" elements) keep
their existing parse-as-children behaviour because Astro convention
allows `{expr}` interpolation in them — `<title>{title}</title>` is
common idiom across the existing `examples/minimal-blog` fixture.

### `@astroflare/compiler/src/astro/css-scope.ts` — tiny CSS scoper

Walks a CSS source character-by-character with depth tracking,
splitting it into rules. For each rule's selector list, every
top-level (depth-0) comma-separated selector gets `[data-aflare-h="<hash>"]`
appended (or inserted before any trailing pseudo-element like
`::before` so the rule stays valid).

Recurses into `@media` and `@supports` block bodies. Passes
`@keyframes`, `@font-face`, `@page`, `@property`, `@charset`,
`@import`, `@namespace` through unchanged — keyframe selectors
(`from`, `to`, `0%`) and at-rule preludes mustn't be scoped.

14 unit tests in `css-scope.test.ts` cover comma splitting,
pseudo-element vs pseudo-class placement, `@media` / `@supports`
recursion, `@keyframes` exclusion, comments, and string-aware comma
handling.

### Emitter wires scoping into element + style emission

`EmitOptions.scopeHash` (8-char hex) is computed by `compileAstro`
from the source filename and threaded into every `emitChildren` call
so nested children, slot bodies, and fragment children all share the
same scope:

- `emitElement` decorates every HTML element with
  `data-aflare-h="<hash>"`.
- `emitStyleElement` emits `<style>` blocks inline as raw HTML (no
  template interpolation):
  - `<style is:global>` — pass through; emit unchanged minus the
    directive.
  - default — run the body through `scopeCss(...)` and emit the
    rewritten output.
- `documentHasScopedStyle` short-circuits the per-element decoration
  when the document only has `is:global` styles, so global-only
  components don't pay for the data attribute.

Components (`<Layout>`, etc.) and fragments don't get the data
attribute — child components have their own scope.

### `import.meta.env` compile-time substitution

`AstroflareConfig.env` (new optional `Record<string, unknown>`) is
threaded through `ModuleGraph` → `compileAstro` → `transformTS` as
esbuild's `define` map. Each entry becomes
`import.meta.env.<KEY>` mapped to the JSON-stringified value, which
esbuild substitutes during the existing TS-strip pass.

The compile cache key includes the env map, so changing config
invalidates compiled artifacts (no stale substitutions).

End-to-end:

```ts
// astroflare.config.ts
export default defineConfig({
  env: { MODE: "production", VERSION: "1.2.3" },
});
```

```astro
---
const v = import.meta.env.VERSION;  // → "1.2.3" at compile time
---
<p>v={v}</p>
```

## Numbers

- **465 tests / 40 files / 5 pools** all green.
- 20 new tests since Phase 11:
  - `compiler/astro/css-scope.test.ts` — 14 unit tests
  - `compiler/astro/end-to-end.test.ts` — 6 tests (4 scoped CSS, 2 env)
- Framework boundary still holds: zero `cloudflare:` / `@cloudflare/`
  imports in framework packages.

## Surprises

- **`<title>` is officially "escapable raw text"** per the HTML
  living standard, but Astro convention treats it like a normal
  template tag because users put expressions in it. Initial
  Phase-12 implementation included `<title>` in the raw-text set,
  which broke the existing `examples/minimal-blog` fixture's
  `<title>{title}</title>`. Narrowed the raw-text set to just
  `<style>` and `<script>`.

- **esbuild's `define` works on dotted member accesses.** No regex
  hacks needed for `import.meta.env.X` substitution — esbuild's
  `define: { "import.meta.env.MODE": '"production"' }` does the
  right thing as part of the TS-strip pass. JSON-stringifying the
  value gives valid source code that esbuild splices in.

- **Slot children inherit the parent's scope.** Originally
  `emitChildrenStrippingSlot` (called when emitting components'
  slot maps) built a fresh empty `EmitContext` — meaning the parent
  component's scope didn't propagate into slot content rendered
  inside the parent. Threaded `parentCtx` through so the data
  attribute appears on slot-rendered elements too. (The child
  component's elements remain in the child's scope, separate.)

- **`emitDocument`'s body emit had to start passing the context.**
  Phase 11 was happy with `emitChildren(nodes, slotsRef)` and
  letting the inner builder construct a default ctx. Phase 12 needs
  the document-level ctx to flow through every nested emit. Mostly
  mechanical but touched five call sites.

## What did NOT land in this run (and why)

- **CSS modules** (`*.module.css`). Astro supports them; we don't
  yet have a separate CSS module loader. Lower priority than
  scoped+global which covers most use cases.

- **PostCSS pipeline.** Astro lets users plug in PostCSS plugins via
  config. Adds another layer of compile-time work; punted to when
  user demand surfaces.

- **`astro:env` runtime helpers** (`getSecret(name)`,
  `setEnv(...)`). Compile-time substitution only for now. Runtime
  secret helpers belong with Phase 15's host-side `EnvService` —
  secrets shouldn't be inlined at compile time anyway.

- **Source-position-preserving CSS scoper.** The current scoper is
  text-in-text-out; it doesn't carry source positions for editor
  tooling. Phase 13 (asset pipeline + source maps) will revisit.

- **Single-colon legacy pseudo-elements.** `:before` / `:after` /
  `:first-line` / `:first-letter` need the attribute inserted
  before them; the current scoper only special-cases the modern
  `::` form. Authors should prefer `::`. Documented as a carve-out
  in `css-scope.ts`.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm lint` — green (128 files).
- `pnpm test` — **465 tests across 40 files, all 5 pools green**.
- Framework boundary check — zero `cloudflare:` / `@cloudflare/`
  matches in framework packages.

## What the next phase starts from

Phase 13 is **asset pipeline + image transforms + source maps**.
Source maps need to ride from the parser through emit; the CSS
scoper from this phase is a useful stress test for the source-map
preservation work since it does substantial text manipulation
inside CSS rules.
