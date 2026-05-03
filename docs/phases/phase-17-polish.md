# Phase 17 — View transitions, prefetch, RSS, sitemap

**Goal:** the small Tier 2 polish tail. Pages that opt in get
SPA-style cross-fade navigation via the View Transitions API, link
prefetching on hover/intersection, and one-line RSS + sitemap
generation from content collections.

**Status:** done. **628 tests / 56 files / 6 pools all green** (was
599 at end of Phase 16).

## What landed

### View transitions

`<ViewTransitions />` runtime component (re-exported from
`@astroflare/runtime`). Users place it inside `<head>`; it emits a
marker `<meta name="aflare-view-transitions">` plus a
`<script type="module" src="/_aflare/view-transitions.js">`.

The script (`view-transitions-client.ts`):
- Intercepts same-origin link clicks (skipping modifier-key /
  middle-click / `target="_blank"` / cross-origin / hash-only nav).
- Fetches the next document with an `x-aflare-vt: 1` header.
- Wraps the DOM swap in `document.startViewTransition()` when
  available; falls back to a synchronous swap otherwise.
- Re-executes inline scripts after the swap (browsers don't run
  inserted `<script>` content automatically).
- Listens to `popstate` so back/forward also goes through the API.

Two surfaces (matching Phase 5 / 16):
- `installViewTransitions(opts)` — typed entrypoint tests drive.
- `VIEW_TRANSITIONS_CLIENT_SOURCE` — string the server serves at
  `/_aflare/view-transitions.js`.

### Prefetch

`<Prefetch />` runtime component emits the
`/_aflare/prefetch.js` script. Users opt links in via
`data-aflare-prefetch` (default = `hover`) or
`data-aflare-prefetch="viewport"`.

The script (`prefetch-client.ts`):
- `mouseover` / `focusin` triggers fetch for `hover` strategy.
- `IntersectionObserver` triggers fetch for `viewport` strategy.
- Sends `x-aflare-prefetch: 1` header + `priority: "low"` fetch
  hint. Errors are silent (prefetch is a hint, never load-bearing).
- Per-URL dedupe via in-memory `Set`.

### Routes

Two new preview-server routes alongside `/_aflare/hydration.js`:

- `GET /_aflare/view-transitions.js` — serves
  `VIEW_TRANSITIONS_CLIENT_SOURCE`.
- `GET /_aflare/prefetch.js` — serves `PREFETCH_CLIENT_SOURCE`.

Both go through a shared `serveStaticClient(source)` helper
(refactored out of the existing hydration handler) with the same
cache-control as the hydration script (`public, max-age=300`).

### RSS

`generateRss(input)` — pure function returning RSS 2.0 XML.

```ts
import { generateRss } from "@astroflare/runtime";
export async function GET(ctx: APIContext) {
  return new Response(generateRss({
    title: "My Blog",
    description: "...",
    site: ctx.site!,
    items: posts.map((p) => ({ title: p.data.title, link: ..., pubDate: p.data.date })),
  }), { headers: { "content-type": "application/rss+xml" } });
}
```

Channel-level: title / link / description / language /
`atom:link rel="self"`. Per-item: title / link / description /
pubDate (RFC-822) / guid (auto-permalink) / categories. Defangs all
XML-significant characters in user-supplied strings.

### Sitemap

`generateSitemap(input)` — pure function returning sitemaps.org
0.9-spec XML. Accepts plain string entries (relative paths
resolved against `site`) or rich entries with
`lastmod` / `changefreq` / `priority`. Priority outside `[0, 1]` is
clamped.

## Numbers

- **628 tests / 56 files / 6 pools** all green (was 599).
- 29 new tests:
  - `runtime/src/rss.test.ts` — 6 tests (channel shape, item
    fields, guid mode, escaping, feedPath override, date format).
  - `runtime/src/sitemap.test.ts` — 6 tests (string + rich
    entries, absolute URL passthrough, priority clamp, leading
    slash, escaping).
  - `runtime/src/view-transitions-client.test.ts` — 6 happy-dom
    tests (click interception, modifier-key bypass, cross-origin
    bypass, `startViewTransition` integration, dispose, source
    sanity).
  - `runtime/src/prefetch-client.test.ts` — 7 happy-dom tests
    (hover trigger, dedupe, plain-link bypass, cross-origin bypass,
    viewport-strategy hover bypass, IntersectionObserver wiring,
    source sanity).
  - `runtime/src/components.test.ts` — 2 new tests for
    `<ViewTransitions>` / `<Prefetch>` markup.
  - `preview/src/preview-server.test.ts` — 2 new route tests
    (`/_aflare/view-transitions.js`, `/_aflare/prefetch.js`).

## Surprises

- **`document.body.replaceWith()` loses the live reference under
  happy-dom.** First cut of the SPA swap did
  `document.body.replaceWith(next.body)`, which works in real
  browsers but causes `document.getElementById` lookups in later
  tests to return `null` because happy-dom's body reference doesn't
  re-bind. Switched to `document.body.innerHTML = next.body.innerHTML`
  — same observable behaviour, no test brittleness.

- **`priority: "low"` is now in lib.dom.d.ts.** The first cut had
  `// @ts-expect-error — non-standard but supported in Chromium`
  on the `priority` field; TypeScript flagged the directive as
  unused (the field is now well-typed). Removed the comment.

- **The bundle module map is in three places.** Adding any new
  runtime file means updating `RUNTIME_BUNDLE_MODULES` in three
  test entry points (`compiler-e2e.test.ts`, `latency.test.ts`,
  `harness.ts`). Same shape as the Phase 14/15a/16 bumps. A
  follow-on cleanup would compute the map once and re-export it;
  Phase 19 territory.

## What did NOT land in this run (and why)

- **Auto-build the sitemap from the route table.** The plan's
  intent: `site.xml` rendered automatically without a user-written
  endpoint. Doable but scope creep — the helper is the load-bearing
  bit. A follow-up phase or example fixture wires the route.

- **Atom feed alternative for RSS.** Same reasoning. RSS 2.0 covers
  the common feed-reader path; Atom is mostly ergonomic.

- **`<ViewTransitions persist>` opt-out per-link.** Astro's surface
  has `<a data-astro-reload>` for forcing full navigation. We don't
  yet — `<a target="_blank">` and modifier keys cover the obvious
  cases.

- **Prefetch tap strategy.** Astro has `tap` (mousedown/touchstart)
  in addition to `hover`. We have `hover` + `viewport`. Tap is one
  more event handler when there's demand.

- **Custom directive registry for prefetch.** Same shape as
  hydration — hard-coded today, registry when there's demand.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm test` — **628 tests across 56 files, all 6 pools green**.
- Framework boundary check — none of the new code imports from
  `cloudflare:workers` or `@cloudflare/*`; runtime stays portable.
- A page in the integration tests that imports
  `<ViewTransitions />` ships the marker meta + script tag in
  rendered HTML. Verified in the new component test.
