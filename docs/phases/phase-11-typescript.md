# Phase 11 — TypeScript support throughout

**Goal:** users can author `.astro` frontmatter and `.ts` endpoints /
middleware in TypeScript. The compiler strips type syntax via
esbuild-wasm. Plus the cross-cutting "regex literal disambiguation"
parser fix that was riding along.

**Status:** done. **445 tests / 39 files / 5 pools all green** (up from
427 at end of Phase 10).

## What landed

### `@astroflare/compiler/src/ts.ts` — esbuild-wasm-backed TS strip

`transformTS(source, opts?) → Promise<string>`. Lazy one-shot
initialisation per process; subsequent calls reuse the same instance.
The `transform` call uses `loader: "ts"` (TS is a superset of JS, so
JS-only frontmatter passes through unchanged at sub-ms cost after init).

Uses esbuild-wasm rather than native `esbuild` so the same module
runs in workerd (Phase 15 Compile DW). The framework-boundary check
in the brief's §11.5 still holds — esbuild-wasm is a regular npm
package with no `cloudflare:` imports.

### `compileAstro` is now async

`compileAstro(source, opts) → Promise<CompileResult>`. The hoisting
step from Phase 10 remained; after the emitter wraps the frontmatter,
`transformTS` runs over the whole module to strip TS syntax. Two
recoverable error paths:

- **Genuine syntax error in user code** — surfaced via `errors[]` so
  the dev error overlay can display it.
- **esbuild-wasm cannot initialise in the runtime environment** (e.g.
  workerd test-pool without WASM bindings) — silently skipped, fall
  back to the un-stripped emitter output. Detected via
  `isEsbuildEnvironmentError` matching on `wasmURL` / `wasmModule` /
  `initialize` / `fetch.*esbuild`.

Sites updated for async: `module-graph.ts:#compileSource`,
`compiler/astro/end-to-end.test.ts:render`. Both already lived in
async contexts so the change is mechanical.

### Frontmatter top-level imports also hoist

Phase 10's `hoistTopLevelExports` extended into
`hoistTopLevelExports` with a recognised `import` form. Same algorithm
(brace/paren/bracket-depth tracking, simple string/template/comment
handling) — just one more match shape. Imports must hoist now because
esbuild's TS-strip parses the wrapper-emitted code and an `import`
inside a function body is a syntax error. The inline bundler later
rewrites/strips them, but the strip pass runs first.

### Inline bundler handles esbuild's normalised export shape

esbuild's `format: "esm"` rewrites `export default <expr>` into
`var stdin_default = <expr>; export { stdin_default as default };`,
and `export const X = …` into `var X = …; export { X };`. The
existing bundler regexes (`EXPORT_DEFAULT_RE`, `EXPORT_NAMED_RE`)
matched the pre-strip shapes but not these. Added `EXPORT_LIST_RE`
to parse `export { ... };` blocks and route each entry to either
`__default = src;` or the `namedExports` map. Same change applied to
the `endpoint.ts` and `middleware.ts` `rewriteExports` helpers (which
do similar work for the IIFE-wrapped endpoint/middleware modules).

### `.ts` endpoints

Router's `PAGE_EXTENSIONS` grew an entry for `.ts` (kind `endpoint`).
`runEndpoint` now reads source bytes, runs them through `transformTS`
when the file path ends in `.ts`, then bundles as before. esbuild
init failure falls through to the original source — JS-only `.ts`
files load fine; type annotations would surface as a runtime error.

### `.ts` middleware

`MIDDLEWARE_PATH_CANDIDATES` now includes `/src/middleware.ts`.
`loadMiddleware` runs the source through `transformTS` for `.ts`
files. The preview server's `ensureMiddleware` and the HMR
invalidation subscriber both look for either extension.

### Regex-literal disambiguation in the parser

`parser.ts:findMatchingBrace` previously treated every `/` as
division (it's a documented Phase 2 carve-out). Without
disambiguation, an expression like `{x.match(/[}]/)}` would close
the outer brace early at the `}` inside the character class.

Added `isRegexStart(slashPos, openPos)`:
- Walks back from the `/` skipping whitespace.
- At expression start, or after operator-like chars
  (`= ( [ { , ; : ! & | ? + - * % < > ^ ~ /`), it's a regex.
- After certain keywords (`return`, `typeof`, `in`, `of`,
  `instanceof`, `new`, `delete`, `throw`, `void`, `yield`, `await`,
  `do`, `else`, `case`), it's a regex.
- Otherwise division.

And `skipRegexLiteral(start)` walks forward consuming chars with state
for character classes (`[...]`) and backslash escapes, then consumes
flag chars (`gimsuy`).

Heuristic, not a full JS tokenizer — but covers the cases that bite
in template-literal-bearing expressions. Five new parser tests cover
the recognised shapes plus a value-vs-regex precedence check.

## Numbers

- **445 tests / 39 files / 5 pools** all green.
- 18 new tests since Phase 10:
  - `compiler/ts.test.ts` — 7 unit tests for `transformTS`
  - `compiler/astro/end-to-end.test.ts` — 3 TS frontmatter tests
  - `compiler/astro/parser.test.ts` — 5 regex-disambig tests
  - `preview/router.test.ts` — 1 test recognising `.ts` endpoints
  - `preview/preview-server.test.ts` — 2 e2e tests (.ts endpoint + .ts middleware)
- Framework boundary still holds: zero `cloudflare:` / `@cloudflare/`
  imports in framework packages.

## Surprises

- **esbuild's default-export normalisation broke the bundler.**
  Pre-Phase 11, the inline bundler matched `^export default <expr>`
  via regex and rewrote to `__default = <expr>`. After esbuild's
  `format: "esm"` pass, that shape never appears — esbuild always
  produces `var stdin_default = <expr>; export { stdin_default as
  default };`. The bundler had to learn the `export { X as default }`
  form. Same shape change leaked into `endpoint.ts` and
  `middleware.ts` rewriteExports.

- **Test fixture had a redundant `${code}` in `main.js`.** The
  end-to-end Astro test's `main.js` was `${code}\n…wrapper…\nexport
  default __invoke;`, so the file had two `export default`
  statements. Pre-Phase-11 Node accepted it (unclear why); after
  esbuild's normalisation, the rewrite produced two `export { X as
  default };` blocks which Node correctly rejected. Removing the
  redundant `${code}` (the wrapper imports `_inner.js` for the
  compiled component) fixed it cleanly.

- **esbuild-wasm initialisation is global per process.** Calling
  `mod.initialize({})` twice throws. The lazy-init in `ts.ts`
  catches "already initialized" and proceeds. Tests that import the
  same module from parallel test files share the cached instance
  via Node's module cache.

- **Imports in frontmatter were always inside the arrow.** The
  existing emitter put user imports inside the component body. The
  inline bundler hides this because it strips/rewrites imports
  before the runtime sees the code. esbuild's TS-strip pass parses
  the un-bundled emitter output, so it sees the syntactically-broken
  form. Phase 10's hoister was extended to lift imports too.

## What did NOT land in this run (and why)

- **TS-aware error reporting.** esbuild reports errors against the
  post-transform JS, so a TS error line/column drifts from the
  original source. Source-map carry-over lands in Phase 13.

- **Workerd-side esbuild-wasm initialisation.** The Compile DW (Phase
  15) needs to bind the WASM blob. The framework-side compileAstro
  silently degrades when the env can't init esbuild — workerd-pool
  tests use plain JS frontmatter and the un-stripped emitter output
  loads fine.

- **Real declaration-merging for `App.Locals`.** Astro lets users
  declare `App.Locals` in a global `.d.ts`; we keep `Astro.locals`
  generic-typed (`L = Record<string, unknown>`) but don't auto-merge
  the user's declaration. Will revisit when a user actually asks.

- **Destructuring on `export const { x } = …`.** The hoister's
  `EXPORT_DECL_RE` only matches simple-named bindings. Rare in
  frontmatter; can extend later.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm lint` — green (126 files).
- `pnpm test` — **445 tests across 39 files, all 5 pools green**.
- Framework boundary check — zero `cloudflare:` / `@cloudflare/`
  matches in framework packages.

## What the next phase starts from

Phase 12 is **scoped CSS + global CSS + env vars**. The compiler now
has esbuild-wasm available, which is also useful for CSS module
processing if we go that route. The hoisting + bundle-rewrite work
from Phase 11 means new top-level user declarations (e.g. CSS
imports) can hoist cleanly without bundler regression.
