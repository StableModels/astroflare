# Phase 6 — Tier 1 features (subset)

**Brief scope (§3 Tier 1 / §7.6):** Markdown + MDX, syntax highlighting via
Shiki, CSS scoped/global/modules, content collections, asset pipeline,
layouts/slots (already done), env vars.

**Status:** the high-impact subset that makes the framework usable for real
blogs. Markdown + content collections shipped. CSS scoping, env vars, image
transforms, MDX, and Shiki deferred — each its own non-trivial piece of work
(retro covers reasoning).

## What landed

### Markdown compiler (`@astroflare/compiler/src/markdown/`)

Compiles `.md` into the same Astroflare component ABI shape as `.astro`.
`unified` + `remark-parse` + `remark-rehype` + `rehype-stringify`. YAML
frontmatter via `yaml`, exposed as `Astro.props.frontmatter` + a local const
inside the compiled module.

7 unit tests; 3 e2e tests through the preview server.

### `.md` routing

`Router` walks both `.astro` and `.md` files. `Route` gets a `kind:
"astro" | "markdown"` discriminator. Static-before-dynamic precedence; on
ties `.astro` wins over `.md` (matches Astro's behaviour).

`ModuleGraph` dispatches to the right compiler based on file extension.

### `@astroflare/content` package

Astro-shaped content collections:
- `defineCollection({ schema })` — typed schema declaration
- `getCollection(name)` — async, walks `/src/content/<name>/` for `.md`,
  parses YAML, validates against schema, returns `CollectionEntry[]`
- `getEntry(name, slug)` — single entry lookup
- Re-exports `z` (Zod) so users don't need their own dep

12 tests covering schema validation/defaults, slug derivation from nested
paths, malformed YAML, missing collections, body + digest population.

### Numbers
- **316 tests / 27 files / 5 pools** all green (was 293 at end of Phase 5).
- 23 new tests: 7 markdown + 12 content + 3 markdown e2e + 1 router test.

## Carve-outs (deferred, with reasoning)

- **MDX** — `@mdx-js/mdx` is substantively bigger than basic Markdown. The
  ABI overlap with `.astro` (JSX-in-markdown) means we'd want to share the
  `.astro` parser's expression handling. Belongs as its own focused phase.
- **Shiki syntax highlighting** — pure JS but ~5 MB of bundled grammars.
  The framework should accept a `rehype-shiki`-shaped plugin in
  `astroflare.config.ts#markdown.rehypePlugins`; that config plumbing
  doesn't exist yet either.
- **User-supplied remark/rehype plugin chains** — `AstroflareConfig.markdown`
  has the schema slot, but nothing reads it. Quick fix; left for next pass.
- **Named exports from `.md`** — Astro lets users `import { frontmatter }
  from "./post.md"`. Our inline bundler (Phase 4) wraps modules in IIFEs;
  `export const frontmatter` inside an IIFE is invalid syntax. Fix would
  be a smarter bundler that hoists named exports cross-module. The
  preferred-by-Astro pattern (`Astro.props.frontmatter`) does work.
- **Scoped CSS** — `<style>` block parsing + selector rewriting + scope
  hash + element-attribute injection across the compiler. Chunky enough
  to be its own phase.
- **CSS modules / PostCSS** — same.
- **Asset pipeline** — the brief calls for an `ImageService` host
  capability for transforms (delegating to Cloudflare Images in
  production). Interface design is straightforward; user-facing
  `<Image>` / `<Picture>` components and the transform-cache key plumbing
  push it past one-session scope.
- **Env vars** — `import.meta.env.X` compile-time substitution. Small but
  needs config plumbing (which env vars are exposed, how they're sourced
  in dev vs deploy).
- **`astro:env` schema** — Astro's typed env-var declaration. Same.
- **Content-layer custom loaders** — Astro's `loader: () => …` for
  non-filesystem sources. Schema slot exists; wiring deferred.

## Acceptance signals

- typecheck green, lint green (97 files), 316 tests across 27 files / 5 pools all green.
- Framework boundary holds.

## What Phase 7 starts from

- Full route discovery already covers `.astro` and `.md`.
- Module graph + closure walker handles both file types via the
  `compileMarkdown`/`compileAstro` dispatch.
- Content collections give the build pipeline a stable read surface for
  enumerating prerenderable entries (e.g., a build planner can iterate
  every blog post via `getCollection("blog")`).
