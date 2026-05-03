# Phase 18 — i18n routing

**Goal:** the project's `astroflare.config` carries an `i18n` block;
the runtime resolves a per-request locale from the URL prefix and
surfaces it as `Astro.currentLocale`; user code generates locale-
prefixed links via `getRelativeLocaleUrl(locale, path, config)`.

**Status:** done. **643 tests / 57 files / 6 pools all green** (was
628 at end of Phase 17).

## What landed

### Config schema

`AstroflareConfig.i18n?: I18nConfig`. Astro-shaped subset:

```ts
i18n: {
  locales: ["en", "fr", "de"],   // supported set
  defaultLocale: "en",
  routing: "pathname-prefix-other", // default; alt: "prefix-default"
}
```

`pathname-prefix-other` (Astro's default) keeps the default locale at
the root: `/about`, `/fr/about`, `/de/about`. `prefix-default` puts
every locale under its prefix: `/en/about`, `/fr/about`, `/de/about`.

### Runtime helpers

`packages/astroflare-runtime/src/i18n.ts`:

- `deriveLocale(pathname, config)` — pure: look at the first path
  segment; if it's in `config.locales`, that's the locale; otherwise
  return `config.defaultLocale`. Used by the preview/deploy router.
- `getRelativeLocaleUrl(locale, path, config)` — pure: strip leading
  slash, prefix with `/<locale>/` (or leave bare for the default
  locale under `pathname-prefix-other`). Special-cases `/` so the
  result is `/<locale>` rather than `/<locale>/`.

Both are framework-agnostic — no `URL`, no globals, easy to unit-test.

### `Astro.currentLocale` plumbing

Added to `SharedRenderContext`, `RenderContext`, `AstroLike`,
`AstroGlobal`, and `EndpointContext`. The preview-server route
handler reads `opts.config.i18n` once per request and computes
`currentLocale: deriveLocale(url.pathname, i18n)` before passing the
context to the executor or the endpoint runner. Pages access it as
`Astro.currentLocale`; endpoints pull it off the `APIContext`.

`undefined` when no `i18n` is configured — opt-in only.

### Routing

No router-level changes needed: `[lang]` directories are already
handled by Phase 3's `RE_PARAM_SEGMENT` (treats `[lang]` as a generic
single-segment dynamic param named `lang`). The i18n config informs
*locale resolution*, not *route matching* — the developer puts pages
under `src/pages/[lang]/...` (or `src/pages/about.astro` for the root
locale), and the URL match drives both `params.lang` and
`Astro.currentLocale` (which the runtime computes independently from
the `i18n.locales` list, so the two stay in sync without any compiler
help).

## Numbers

- **643 tests / 57 files / 6 pools** all green (was 628).
- 15 new tests:
  - `runtime/src/i18n.test.ts` — 10 tests covering both routing
    strategies, default-locale fallback, leading-slash normalisation,
    `/` special-casing, unknown-prefix passthrough.
  - `runtime/src/render.test.ts` — 2 new tests for
    `Astro.currentLocale` propagation.
  - `preview/src/preview-server.test.ts` — 3 new integration tests:
    URL prefix → currentLocale, fallback to default, undefined when
    no i18n.

## Surprises

- **No router change needed.** First instinct was to special-case
  `[lang]` segments in the matcher. Phase 3's design already handles
  them as generic dynamic segments; the only new thing is computing
  `currentLocale` alongside `params`. Saved a chunk of plumbing.

- **Test fixtures couldn't pass i18n through.** The
  `makeFixture(files)` helper in `preview-server.test.ts` hardcoded
  `config: { site: ... }`. Extending it with a
  `configOverrides: Partial<AstroflareConfig> = {}` second parameter
  threads i18n into the test runs without breaking the existing
  call sites.

## What did NOT land in this run (and why)

- **Locale-aware route rewriting / fallback.** Astro's i18n surface
  also serves `/fr/missing` from `/missing.astro` if the localised
  copy is absent (configurable). We don't yet — pages have to exist
  under `[lang]/`. The plumbing's there for a follow-up.

- **`Astro.preferredLocale` / `Astro.preferredLocaleList`.**
  `Accept-Language`-driven negotiation. Adds another 30-line helper;
  fits whenever a real userbase asks.

- **`getAbsoluteLocaleUrl` / `getLocaleByPath` / etc.** Astro's full
  surface has six helpers; we ship the two that `Phase 18` actually
  needs (`getRelativeLocaleUrl` for link generation, `deriveLocale`
  for context). The rest is mostly trivial wrappers.

- **Variant explosion in the deploy planner.** A 3-locale, 50-page
  site is 150 deploys. We don't expand i18n routes at deploy time
  yet; the live SSR fallback handles them. Pre-expansion is a
  perf optimisation for static sites — Phase 19 territory.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm test` — **643 tests across 57 files, all 6 pools green**.
- Framework boundary check — i18n module imports only from
  `@astroflare/core`'s type re-exports, no `cloudflare:*`.
- A page declared as `[lang]/about.astro` with an `i18n` config
  reading `Astro.currentLocale` renders `/fr/about` with `locale=fr`
  and `/about` with `locale=en` (the default locale at the root in
  `pathname-prefix-other` mode). Verified end-to-end.
