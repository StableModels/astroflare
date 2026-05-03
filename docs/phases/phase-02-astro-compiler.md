# Phase 2 — `.astro` compiler

**Goal (from §7.2 of the brief):** hand-roll a TypeScript parser + emitter for
`.astro`. Pure JS. Output ABI must match Astro's: a default export of a render
function with the signature `(result, props, slots) => Promise<RenderResult>`.

**Status:** Tier 0 grammar + emitter + runtime ABI + tests landed. Carve-outs
documented below.

## What landed

### Runtime ABI (`@astroflare/runtime/internal`)

A working — not stub — implementation of every symbol the compiler emits
imports against:

- `$component(cb)` — wraps a user render function so it returns a `RawHtml`
  marker, regardless of what the user returned.
- `$render` — tagged template that interleaves static HTML strings with
  flattened values. Returns `Promise<RawHtml>`. Awaits Promises, recursively
  flattens arrays, recognises nested `RawHtml` so it never double-escapes,
  HTML-escapes everything else.
- `$renderComponent(C, props, slots)` — invokes a tagged component, throws
  on a non-component value.
- `$renderSlot(slots, name?, fallback?)` — looks up a slot, falls back, or
  returns empty.
- `$escape` — five-character HTML escape (`& < > " '`). Recognises `RawHtml`
  and passes it through.
- `$rawHtml` — wraps a string of pre-rendered HTML in a marker.
- `$attr` / `$attrPair` — single attribute value / complete `' name="..."'`
  pair, with truthy/falsy/empty handling.
- `$spreadAttrs` — `{...obj}` → `' k1="v1" k2"`.
- `$defineVars` — `<script define:vars={...}>` preamble emitter.
- `$hydrationMarker` — Phase 2 placeholder comment; Phase 8 swaps in the
  real `<astro-island>` element.
- `renderToString(value)` — public entrypoint that flattens any value
  (raw HTML, Promise, string, render result) into a final HTML string.

32 tests cover each symbol's contract, including non-double-escaping, array
flattening, attribute escaping edge cases, and empty/false/null normalization.

### Compiler — parser (`@astroflare/compiler/src/astro/parser.ts`)

Single-pass recursive descent. No separate token stream — for HTML-with-JSX
expressions the boundaries between text, tags, and `{...}` are unambiguous
once we're tracking string/comment/bracket state inside expressions, so a
tokenizer would just be a layer of indirection. (The brief listed 2b
"tokenizer" and 2c "parser" as separate phases; they're unified here, noted
in the retrospective.)

Tier 0 grammar:
- frontmatter `---\n...\n---` (whitespace-tolerant; reports unclosed via
  recoverable error)
- text + `{expression}` interpolation in content position
- HTML elements with all attribute forms: static (`name="v"`,
  `name='v'`, unquoted, boolean), expression (`name={expr}`),
  shorthand (`{name}`), spread (`{...obj}`), directive (`name:foo` or
  `name:foo={expr}`)
- void elements (HTML living standard list) — auto-closed without `/>`
- components (uppercase tag names or dotted member access like `UI.Button`)
- `<slot>`, `<slot name="...">`, fallback content
- `<Fragment>` and `<>...</>` shorthand
- HTML comments and doctypes
- balanced-bracket expression parsing through string literals, template
  literals (with `${...}` substitution), line and block comments
- recoverable errors with 1-based `{line, column}` positions

35 parser tests cover every grammar form including negatives (unclosed
frontmatter / expression / comment / tag, malformed attribute).

### Compiler — emitter (`@astroflare/compiler/src/astro/emitter.ts`)

Walks the AST and produces ESM that imports the runtime ABI symbols and
default-exports a `$component(...)`. Frontmatter is inserted verbatim. Each
node maps to a fragment of a `$render`-tagged template literal:

- text → escaped for template literal context (`\``, `\\`, `\${`)
- expression → `${expr}` (runtime `flatten` does the escaping)
- element → `<tag${attrs}>...children...</tag>` or self-close for void
- component → `${await $renderComponent(Name, props, slots)}` with children
  partitioned into named/default slots based on `slot=` attributes
- slot → `${await $renderSlot($$slots, "name", fallbackFn?)}`
- `set:html={x}` → replaces children with `${$rawHtml(x)}`
- `define:vars={obj}` → prepends `${$defineVars(obj)}`
- `client:{load|idle|visible|media|only}` → emits a `$hydrationMarker(...)`
  before the component call (Phase 8 wires the actual island)
- `<Fragment>` / `<>...</>` → flattened into siblings
- doctype, comments → preserved literally

26 emitter tests cover module shape, attribute forms, slot partitioning,
each directive, fragments, comments, doctype.

### End-to-end pipeline (12 tests)

Source `.astro` → `compileAstro` → `InProcessExecutor` → render → assert HTML.
The runtime is built to `dist/internal.js` by the pretest `tsc -b` step; tests
pass an absolute `file://` URL as `runtimeImport` so the compiled module's
import resolves without needing `node_modules` next to the executor's tmp
directory.

Verified: plain HTML, attribute forms, `set:html`, fragments, void elements,
slot fallbacks, expression interpolation with HTML escaping. Plus a runtime-
driven slot-routing test that doesn't go through the executor.

## What surprised me

1. **The "fresh isolate per call" property in tests carries over for free** —
   InProcessExecutor was already designed to give us new module records, so
   the e2e test of "compile and run" works out of the box. The harness from
   Phase 1 paid for itself the first time it touched a real compiler.

2. **The brief separates tokenizer and parser; one pass beats two layers.**
   For HTML-with-JSX-expressions, the natural split point isn't between
   tokens and tree — it's between *bracket-balancing inside expressions* and
   *everything else*. Once you have a `findMatchingBrace` that walks through
   strings/comments correctly, the parser is straightforward recursive
   descent; an intermediate token stream just adds bookkeeping. Worth flagging
   in case future contributors expect the brief's two-phase split.

3. **Vitest's Vite layer intercepts transitive dynamic imports.** Single-
   module bundles in `InProcessExecutor.runOnce` work fine; bundles where
   the imported module *itself* statically imports another bundle module
   trip Vite's SSR-transform path with "'import', and 'export' cannot be
   used outside of module code". The single-module e2e tests are unaffected
   (they only import the runtime via absolute file:// URL); the multi-module
   composition test was reworked to drive composition through the runtime
   API directly. Real preview/build pipelines do their own URL rewriting and
   don't go through Node's resolver for inter-`.astro` imports, so this is
   a test-harness limitation, not a runtime gap. See the carryover below.

4. **`set:html` requires open/close tags even on syntactically self-closing
   elements.** `<div set:html={x} />` and `<div set:html={x}></div>` both
   emit `<div>{x}</div>` because the directive logically *contains* content.
   I almost emitted `<div/>` for the self-closing form (which would have
   been wrong); test assertion caught it.

5. **Node's `Response` ban on status 101** (caught in Phase 0) bit again
   when the runtime tests almost reached for `WebSocketPair`. Comment in the
   runtime stub explains it; future Phase 5 HMR work needs to be in the
   workerd test pool, not the framework one.

6. **`pnpm test` chained on `tsc -b`** is the small cost that makes the e2e
   pipeline honest. The runtime's `dist/internal.js` is the import target;
   without an incremental build we'd need either a TS loader inside the
   executor (lots of plumbing) or a parallel JS-only runtime source
   (duplication). Incremental tsc is fast; this scales.

## Carryovers

### Phase 4 (preview module graph + URL rewriting)
- Multi-module .astro composition end-to-end through the executor. Currently
  blocked by Vite's interception of nested dynamic imports; once we own
  module URL resolution (and the executor uses a `WorkerCode.modules` map
  rather than file:// dynamic imports), this works without test-harness
  contortion.
- The `.astro` extension import problem: Node refuses to load `.astro` files
  as ESM. Real preview rewrites `import "./Foo.astro"` to `/_aflare/mod?p=...&v=...`
  before serving. The build pipeline rewrites it to a content-hashed `.js`
  artifact. Both belong with the URL-rewriter.

### Phase 6 (TS frontmatter + MDX)
- TS frontmatter is currently passed through verbatim. End-to-end tests use
  JS-only frontmatter. Phase 6 wires the type-stripping path (esbuild-wasm
  inside a Compile DW; for tests, esbuild via Node).

### Phase 8 (client islands + hydration)
- `client:*` directives emit a `$hydrationMarker(...)` placeholder comment.
  The actual `<astro-island>` element + per-island client bundle URL is
  Phase 8's job.

### Compiler-internal carve-outs
- **`is:raw`**: parsed correctly but not yet special-cased by the emitter.
  Expressions inside an `is:raw` element are still evaluated. Fix: route
  children of `is:raw` elements through their original source range
  (kept on AST nodes via `Range`), bypassing expression interpolation.
- **Source maps**: `EmitResult.map` is `null`. Phase 4 wants source positions
  in HMR error overlays; the data is already in the AST (every node has a
  `Range`), wiring is mechanical.
- **Regex literal disambiguation in expressions**: `findMatchingBrace`
  doesn't distinguish regex literals from division. A standalone regex inside
  an expression with unbalanced braces in its character class would confuse
  the matcher. Workaround for users: hoist the regex to frontmatter. Fix:
  add a heuristic that tracks "are we in a position where `/` could start
  a regex" (after operators, opening brackets, etc.).
- **Differential parity tests vs Astro**: deferred — needs an `astro` install
  in dev deps, plus a curated subset of their compiler test corpus. Worth a
  separate Phase 2.5 or rolled into Phase 6 alongside MDX (which also wants
  fixture porting).

## Acceptance signals at phase close

- `pnpm typecheck` — green.
- `pnpm lint` — green (69 files).
- `pnpm test` — **181 tests across 17 files, all 4 pools green** (was 75
  at end of Phase 1).
- Framework boundary check — zero `cloudflare:` / `@cloudflare/` matches in
  framework packages (acceptance criterion §11.5).

## What Phase 3 starts from

- `@astroflare/runtime/internal` exports a working render pipeline; `$render`
  produces a final `RawHtml` from primitives, components, slots.
- `@astroflare/compiler#compileAstro(source, opts)` is a single-call source-
  to-ESM compiler.
- The `Astro.*` API surface (Astro.props, Astro.params, Astro.request, etc.)
  is referenced from emitted code (`{ Astro, ...$$props }`) but not yet
  fully populated — Phase 3 wires `Astro.params`, `Astro.url`,
  `Astro.redirect`, `Astro.cookies`, `getStaticPaths()` through the
  request-render pipeline.
- The preview server is a thin layer that reads a route file via `Storage`,
  calls `compileAstro` cached by content hash via `Executor.runCached`,
  invokes the default export with `{ Astro, ...props }`, and `renderToString`s
  the result.
