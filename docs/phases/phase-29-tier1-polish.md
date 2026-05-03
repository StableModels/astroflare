# Phase 29 — Tier 1 polish (carryovers)

**Goal:** capture the Tier 1 carryovers that have accumulated across
Phases 11–19 in one coordinated pass. None of these block the v0.1.0
North Star release; they're real-world content-site polish that
becomes important once users start authoring against the framework
in anger.

**Status:** planned. User-demand-driven; pull individual items
forward when a real workflow surfaces them.

## What's in scope

Each item is a small, scoped piece of work — a few hundred LOC and
a handful of tests. They're listed by area and tagged with their
originating phase retro for context.

### Compiler quality

- **Per-token source maps** (Phase 13 carryover). Compiler ships a
  structural placeholder today; the AST `Range` data is there. Wire
  it into a v3 source map output so user errors surface line/column
  in the original `.astro` source.
- **Parser-level `is:raw`** (Phase 19 carryover). Today's
  emit-time-only handling means unbalanced parens inside `is:raw`
  children still hit the expression parser. Move the directive
  detection earlier so the AST treats children as opaque text.

### CSS

- **CSS modules** (`*.module.css`) — Phase 12 carve-out. Local
  scoped class names compiled at import time.
- **PostCSS pipeline** — Phase 12 carve-out. Plugin chain users can
  configure via `astroflare.config.ts`.

### Asset pipeline

- **Image format conversion** (AVIF / WebP) — Phase 13 carve-out.
  Cloudflare Images binding does this server-side; expose `<Image
  format="avif">` props.
- **DPR variants** — Phase 13. `<Image srcset>` for `1x`, `2x`, `3x`.
- **Blurred placeholders** — Phase 13. Compile-time tiny base64
  preview emitted as inline `<img>` blur target.

### Content

- **Content-layer custom loaders** (Phase 14 carve-out). Astro's
  `loader: () => …` API for pulling collection entries from
  non-filesystem sources (database, API, RSS feed).
- **User remark/rehype plugin chains** — Phase 14 carve-out. Users
  configure markdown processing via `astroflare.config.ts`.
- **Named exports from `.md`** beyond `frontmatter` — already
  partially shipped; round out the surface (named-export `headings`,
  `excerpt`).

### MDX

- **MDX components-from-config** (`MDXProvider`-style) — Phase 14
  carve-out. Project-wide `components: { h1: MyHeading }` in config.
- **Custom Shiki transformers** — Phase 14 carve-out. Line numbers,
  diff highlighting, copy buttons.

### i18n

- **`Astro.preferredLocale` from `Accept-Language`** (Phase 18). Today
  available; round out the surface.
- **Locale-aware route fallback** — Phase 18. Serve `/fr/missing`
  from `/missing.astro` when localised copy is absent.
- **Rest of Astro's i18n helper surface** — `getAbsoluteLocaleUrl`,
  `getLocaleByPath`, etc.
- **Variant pre-expansion in deploy planner** — produce one snapshot
  entry per locale automatically.

### Hydration / interactivity

- **Phase 16c shared React chunk** — Multi-island pages re-import
  from `/_aflare/react.js`; module cache dedupes bytes after first
  hit but each page still does the resolution. Move React to a
  shared chunk all islands import once.
- **MDX components-from-config** (also covers React in MDX).

### Polish

- **Auto-built sitemap from route table** — Phase 17 carve-out.
  `<Sitemap />` runtime helper auto-discovers static routes.
- **Atom feed alternative** — Phase 17. Sibling to `generateRss`.
- **`tap` prefetch strategy** — Phase 17. Browser prefetches on
  pointer-down, not hover.
- **`<a data-aflare-reload>` view-transition opt-out** — Phase 17.

### Quality gates

- **Differential parity vs Astro corpus** (Phase 19b). ≥80%
  byte-equivalent on the Astro `examples/` corpus. Substantial; one
  of the brief's §11.6 acceptance criteria.

## How to land

These don't ship as one big PR. The phase plan exists so the
backlog is visible; individual items pull forward when:

- A user (real or hypothetical-stakeholder) hits the gap.
- Adjacent work is touching the area anyway (e.g. a CSS bug fix
  ships next to CSS-modules support).
- A maintainer schedules a "Tier 1 polish" sprint.

For each landed item:

1. Reference this doc in the commit message ("Phase 29: CSS modules
   support").
2. Strike the line above + add a brief retro note pointing at the
   commit.
3. Add a unit/Layer-A test in the relevant package.

## Acceptance

Done when the list above is empty (every line either struck or
explicitly cut to Tier 2/3).

## Order rationale

Demand-driven. The Phase 24b release-readiness checklist doesn't
require any of these items; they're polish, not blockers. The
suggested cadence is "fold one or two into each post-v0.1.0 minor
release."
