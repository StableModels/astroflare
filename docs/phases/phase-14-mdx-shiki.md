# Phase 14 — MDX + Shiki + named `.md` exports

**Goal:** full MDX (JSX-in-Markdown via `@mdx-js/mdx`); Shiki shipped
as the one opinionated syntax-highlighter default; the inline
bundler hoists arbitrary named exports cross-module so
`import { frontmatter } from "./post.md"` finally works.

**Status:** done. **521 tests / 46 files / 5 pools all green** (was
482 at end of Phase 13).

## What landed

### Cross-module named-export hoisting (`preview/src/bundle.ts`)

The bundler used to recognise exactly one named export
(`getStaticPaths`) — a `NAMED_EXPORTS_OF_INTEREST` allowlist filter
gated everything else out of the per-module IIFE return object. That
hard-coded list became technical debt the moment named imports of
`.md` files mattered. Phase 14 deletes the filter: every named
export — declared (`export const x`), function/class
(`export function f` / `export class C`), or via esbuild's
normalised list (`export { … as default, … }`) — flows into the
IIFE's return slots.

Imports of compilable files (`.astro`, `.md`, `.mdx`) parse through
a single `COMPILABLE_IMPORT_RE` + `parseImportClause()` helper that
handles every shape:

```ts
import X from "./Foo.md";                  // default
import { frontmatter } from "./post.md";   // named
import * as ns from "./post.mdx";          // namespace
import X, { frontmatter } from "./post.md"; // mixed
import { a as b, c } from "./post.md";     // renamed + multi
```

Each case lowers to one or more `const … = __m_<idx>.…` lines
inside the importer's IIFE — destructuring against the importee's
return object. Two new end-to-end preview-server tests (`a .astro
page can import { frontmatter } from a .md file`, `default + named
together`) lock the behaviour in.

The markdown compiler's emitter switched accordingly: `frontmatter`
is now `export const frontmatter = …` rather than a local `const`.
The MDX compiler emits the same shape.

### MDX compiler (`compiler/src/mdx/`)

`compileMdx(source, opts) → { code, frontmatter }`. Pipeline:

1. Strip YAML frontmatter from the source so MDX doesn't parse
   `---` as a thematic break.
2. Run `@mdx-js/mdx`'s `compile()` with
   `jsxImportSource: "@astroflare/runtime"` and `development: false`.
3. Rewrite the `import {jsx as _jsx, …} from
   "@astroflare/runtime/jsx-runtime"` line into a const-aliasing
   declaration (`const _jsx = jsx, _jsxs = jsxs, _Fragment =
   Fragment;`) so the inner module body can find its JSX symbols
   after the bundler strips top-level imports.
4. Strip `export default` from MDX's emitted
   `MDXContent(props = {})` declaration so it becomes a plain
   `function MDXContent(…)` we can call from our wrapper.
5. Append `export const frontmatter = …;` and an
   `export default $component(async ({Astro, …$$props}, $$slots) =>
   $render\`${$rawHtml(await MDXContent($$props))}\`)` wrapper so
   the rest of the framework consumes MDX through the standard
   `AstroComponent` ABI.

9 tests cover the round-trip: basic markdown, frontmatter as a
named export, JSX expressions inline, jsx-runtime import rewrite,
runtime ABI import, invalid YAML, JSON round-trip of frontmatter,
empty frontmatter, internal rehype plugins (the surface Shiki
rides). Plus 4 preview-server tests for full `.mdx` route
rendering.

### JSX runtime (`runtime/src/jsx-runtime.ts`)

Public exports: `jsx`, `jsxs`, `jsxDEV` (all aliases), `Fragment`
(a `Symbol.for("astroflare.jsx.Fragment")`). All return
`Promise<RawHtml>` so the result composes with `$render` and
existing `RawHtml`-aware sites without double-escaping.

Three element-type cases:
- **Fragment** — render children only.
- **String** (e.g. `"h1"`) — emit `<tag attrs>children</tag>`, or
  self-close for void elements (`<br/>`, `<img/>`, …). Attribute
  names map `className` → `class` and `htmlFor` → `for`; everything
  else is verbatim.
- **Function** — invoke as a component. Components flagged
  `__astroComponent` flow through `$renderComponent` so they get a
  per-call `Astro` arg + slot map (children become the `default`
  slot); plain functions just get the props.

Children handle string / number / null / RawHtml / Promise /
nested-array recursively. 16 tests cover every case.

The runtime's package.json gained `./jsx-runtime` and
`./jsx-dev-runtime` exports; `runtime/index.ts` re-exports
`jsx`, `jsxs`, `jsxDEV`, `Fragment` so a `runtimeImport` URL
pointing at the main entry can serve them too.
`BUNDLE_RUNTIME_SYMBOLS` in the inline bundler picked up the four
new names so the bundle's outer scope provides them.

### Shiki (`compiler/src/shiki/`)

A unified `rehype` plugin. Walks the hast tree, finds every
`<pre><code class="language-…">`, and replaces the pair with
Shiki's highlighted HTML embedded as a `raw` hast node. Single
shared highlighter cached at module scope (first call ~100 ms,
subsequent calls fast). Default theme: `github-dark`. Default
language allowlist: `javascript`, `typescript`, `jsx`, `tsx`,
`json`, `html`, `css`, `markdown`, `mdx`, `bash`, `shell`,
`yaml`, `toml`, `plaintext`. Unknown languages fall back to
`plaintext` rather than throwing.

Wired into both compilers as the default rehype plugin; opt-out
via `{ shiki: false }`. 7 tests cover both md and mdx integration
plus the disabled path.

### Module-graph wiring (`preview/src/module-graph.ts`)

- `.mdx` extension routes to `compileMdx`; `.md` to
  `compileMarkdown`; everything else to `compileAstro`.
- `extractAstroImports` renamed to `extractCompilableImports` and
  expanded to follow `.md`/`.mdx` (was `.astro` only). The closure
  now picks up `import { frontmatter } from "./post.md"` references
  so the bundler can hoist named exports cross-module.

### Router + content reader

- `routeFromFilePath` recognises `.mdx` as a markdown route. The
  PAGE_EXTENSIONS list orders `.mdx` before `.md` so that a file
  with both extensions present in the same dir resolves the longer
  suffix first.
- `createContentReader`'s `ENTRY_EXTENSIONS` adds `.mdx`. Same
  ordering rule. Slug derivation strips whichever suffix matched
  first.

## Numbers

- **521 tests / 46 files / 5 pools** all green.
- 39 new tests since Phase 13:
  - `runtime/jsx-runtime.test.ts` — 16 unit tests
  - `compiler/mdx/index.test.ts` — 9 unit tests
  - `compiler/shiki/index.test.ts` — 7 integration tests
  - `preview/preview-server.test.ts` — 6 e2e tests (2 cross-module
    `.md` named imports, 4 `.mdx` route renders)
  - `preview/router.test.ts` — 1 `.mdx` recognition test
  - `content/index.test.ts` — 1 `.mdx` content-collection test
- Framework boundary still holds.

## Surprises

- **MDX's hast pipeline ≠ rehype-stringify.** Shiki emits its
  highlighted HTML as `raw` hast nodes — fine for the markdown
  pipeline (rehype-stringify with `allowDangerousHtml` passes them
  through verbatim) but `hast-util-to-estree` (used by MDX 3) chokes
  with "Cannot handle unknown node `raw`". Fix: add `rehype-raw`
  after Shiki *only for MDX*, configured with `passThrough` for the
  MDX-specific AST node types (`mdxJsxFlowElement`,
  `mdxJsxTextElement`, `mdxFlowExpression`, `mdxTextExpression`,
  `mdxjsEsm`). Without `passThrough`, rehype-raw tries to HTML-parse
  JSX elements and crashes on the first `<button>`-shaped tag in
  the MDX source.

- **The bundler's import-stripping clashes with MDX's import
  shape.** MDX's compile output has `import {jsx as _jsx, …} from
  "@astroflare/runtime/jsx-runtime"`. The inline bundler strips
  every top-level import inside per-module IIFEs (so the runtime
  ABI only loads once, in the outer scope). That left `_jsx` /
  `_jsxs` / `_Fragment` undefined inside the IIFE. Two-part fix:
  (1) the MDX compiler post-processes the import line into a
  `const _jsx = jsx, _jsxs = jsxs, _Fragment = Fragment;` aliasing
  declaration; (2) `BUNDLE_RUNTIME_SYMBOLS` was extended with the
  four jsx-runtime names so the bundle's outer scope provides them.
  The aliases inside the IIFE then reference the outer-scope names.

- **Removing the named-export allowlist had no regression.** Phase
  4's `NAMED_EXPORTS_OF_INTEREST = ["getStaticPaths"]` filter felt
  load-bearing — it's been there since the first inline bundle
  shipped. Removing it landed clean: existing tests still pass
  because compiled `.astro` modules never had non-`getStaticPaths`
  named exports anyway. The filter was technical debt waiting on a
  use case to remove it.

- **Workerd test fixtures hand-curate runtime dist files.** The
  workerd-pool e2e tests can't `import "@astroflare/runtime"` —
  they ship the runtime as a virtual module map populated from
  `dist/*.js?raw`. Adding `jsx-runtime.ts` to `runtime/src/` meant
  runtime/dist/index.js suddenly imported `./jsx-runtime.js`, which
  the workerd module map didn't have, producing
  `Failed to start Worker: No such module "runtime/jsx-runtime.js"`.
  Two test files needed the new entry added to the map. The failure
  is brutal because the diagnostic comes from workerd, not the
  framework — easy once you know to look.

- **MDX 3's emitted shape is `export default function MDXContent(…)
  { … }`.** Not `function MDXContent…; export default MDXContent;`,
  not `export default _createMdxContent`. So the post-processing
  regex is straightforward (`^[ \t]*export[ \t]+default[ \t]+
  function[ \t]+`). If a future MDX version changes the shape, the
  test that asserts `function MDXContent` will catch it.

- **Shiki's `getLoadedLanguages()` returns canonical IDs only.**
  Aliases (`js` → `javascript`, `sh` → `shell`) aren't in the set,
  so the allowlist check `knownLangs.has(lang)` would refuse `js`.
  The fallback `try { codeToHtml } catch { plaintext }` is still
  there as a safety net for that case.

## What did NOT land in this run (and why)

- **User remark/rehype plugin chains.** The plan deferred this:
  Astroflare ships Shiki as the one opinionated default and waits
  for real demand before exposing user plugin slots. Adding the
  plumbing isn't hard (the compiler already accepts
  `remarkPlugins`/`rehypePlugins` internally) but the configurable
  surface invites churn — what theme? what languages? what
  highlighter? — that's better resolved against actual user pain.

- **MDX components-from-config (`MDXProvider`-style).** Astro's
  `astro:content` API lets users supply a default `<a>` /
  `<img>` / etc. for use inside MDX. Same shape as remark/rehype
  plugins — surface waiting on demand. The current MDX wrapper
  ignores any `props.components` parameter MDX itself supports.

- **Slug overrides via frontmatter `slug`.** Astro lets a user
  override the filename-derived slug by setting `slug:` in the
  frontmatter. Astroflare always uses the filename. Cheap to add
  later (the slug is computed in `slugFor` after frontmatter is
  parsed).

- **Custom Shiki transformers.** Shiki's `transformers` parameter
  lets plugins inject diff syntax / line numbers / copy buttons /
  etc. Phase 14 ships none. The internal API accepts them
  (`ShikiOptions.transformers`) so adding a default would be a
  one-line change once we pick one.

- **PostCSS pipeline for MDX `<style>` blocks.** Same status as the
  `.astro` side — Phase 12 deferred PostCSS. MDX inherits the
  decision.

- **Source maps for MDX-compiled output.** MDX 3 emits source
  positions but our post-processing doesn't preserve them yet.
  Falls into the same Phase 19 (per-token source maps) bucket as
  the `.astro` work.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm test` — **521 tests across 46 files, all 5 pools green**.
- Framework boundary check — zero `cloudflare:` / `@cloudflare/`
  matches in framework packages (Shiki, MDX, rehype-raw, hast-types
  are all non-Cloudflare).
- Cross-module named imports of `.md` work end-to-end: a `.astro`
  page can `import { frontmatter } from "./post.md"` and reference
  the data on the rendered page. Same for `.mdx`.
- `.mdx` files render with full JSX-in-Markdown support and Shiki
  syntax highlighting.

## What the next phase starts from

Phase 15 (host implementation — production deploys) inherits the
cross-module named-export hoisting work. Astro's content
collection patterns lean heavily on `import { frontmatter,
getCollection } from …` — that's now framework-supported. The
host layer's deploy-time bundler can adopt the same
`parseImportClause` helper.

Phase 16 (hydration runtime + React) has a JSX runtime already in
place. The current runtime is server-side / string-rendering;
React integration extends it (or aliases the import) for
client-side hydration. The `__astroComponent` flag distinguishes
Astroflare components from MDX-defined plain functions; the same
flag can distinguish Astroflare components from React components
once that surface lands.
