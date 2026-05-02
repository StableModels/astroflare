# minimal-blog

A small blog fixture exercising the Tier 0 + Tier 1 features Astroflare
ships:

- file-based routing (`src/pages/`)
- Astro components with frontmatter, slots, layouts
- markdown pages (`src/pages/about.md`)
- content collections (`src/content/blog/`) with Zod schemas
- dynamic params (`[slug].astro`) — works in preview; deploy skips
  dynamic routes until `getStaticPaths` lands

This fixture maps to the brief's acceptance criterion §11.1
("`minimal-blog` renders correctly in both hosts"). What it doesn't
yet exercise — scoped CSS and image transforms — are explicit Phase 6
carve-outs documented in the retros.
