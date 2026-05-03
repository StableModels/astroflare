# Phase 8 — Tier 2 (subset): middleware + server endpoints

**Brief scope (§3 Tier 2 / §7.8):** client islands, framework integrations
(React/Preact/Vue/Svelte/Solid/Lit), middleware, server endpoints, view
transitions, prefetch, i18n, RSS, sitemap.

**Status:** middleware + endpoints landed. Framework integrations and
client-island hydration carry their own multi-day phases each — explicitly
deferred. View transitions / prefetch / i18n / RSS / sitemap likewise.

## What landed

### Server endpoints (`endpoint.ts`)

`.js` files in `src/pages/` are now routed as endpoints. Module shape:

```js
export const GET = async ({ request, url, params }) => new Response(...);
export const POST = async (ctx) => ...;
export default async (ctx) => ...;   // method-fallback
```

- Router gains a third `RouteKind: "endpoint"`.
- `runEndpoint(opts)` reads source, wraps user code in an IIFE that
  captures named/default exports into a `__module.exports` object, runs
  through `host.executor.runCached`, dispatches by HTTP method.
- `405 Method Not Allowed` with an `Allow:` header when the method has
  no handler and no `default` exists.
- 6 unit tests cover each shape.

### Middleware (`middleware.ts`)

`/src/middleware.js` wraps every request:

```js
export const onRequest = async (ctx, next) => {
  // pre — auth, logging, redirect-on-condition
  const response = await next();
  // post — header injection, body rewrite
  return response;
};
```

- `loadMiddleware(host, cacheId)` looks up the file, loads via the same
  IIFE-wrap-and-run pattern, returns the `onRequest` (or `default`).
- `sequence(...fns)` composes multiple middleware Astro-style.
- The preview server caches the loaded middleware function across
  requests and invalidates when `/src/middleware.js` changes (subscribed
  to the `hmr` channel with a `trigger`-path filter).
- 6 unit tests cover load / dispatch / short-circuit / sequence ordering.

### Preview-server integration (`preview-server.ts`)

Per-request flow gains two new branches:

1. If the matched route's `kind === "endpoint"`, dispatch to
   `runEndpoint` instead of rendering.
2. If middleware is loaded, wrap the inner handler (page render or
   endpoint) so middleware can pre/post-process and short-circuit.

7 new e2e tests cover GET/405/dynamic-params endpoints, middleware
header injection, middleware short-circuit, middleware-around-endpoint,
middleware reload after edit.

### Numbers
- **348 tests / 30 files / 5 pools** all green (was 329 at end of Phase 7).
- 19 new tests across endpoint, middleware, and preview-server e2e.

## Carve-outs (each its own phase-shaped chunk)

- **Hydration / client islands** — the `<astro-island>` custom element
  implementing `client:load|idle|visible|media`. Currently the compiler
  emits `<!-- astroflare:hydration mode=load -->` placeholder comments
  (Phase 2) for client directives; no runtime swaps in real islands.
- **Framework integrations** — React/Preact/Vue/Svelte/Solid/Lit. Each
  needs its compiler integration (e.g., `@vue/compiler-sfc`,
  `svelte/compiler`) and a hydration adapter. Per the brief, ~14–21
  days for all five.
- **TS endpoints** — same type-stripping carryover as Phase 6
  (`.astro` frontmatter). Today only `.js` endpoints work in dev. Real
  systems will hit the wall quickly.
- **View transitions** — Astro's `<ViewTransitions />` + browser ATA
  registration. Pure-JS implementation possible; deferred.
- **Prefetch** — `client:prefetch`-style hover/intersection-observer
  hooks; deferred.
- **i18n routing** — adds `[lang]` segments and locale-aware route
  rewriting; deferred.
- **RSS / sitemap** — Astro's `astro:rss` and `astro:sitemap`
  integrations. Sit on top of content collections (already shipped in
  Phase 6); ~1 day each when prioritised.
- **Astro middleware-context fields** — `Astro.cookies`, `Astro.locals`,
  `Astro.session`. The `MiddlewareContext.locals` slot exists but isn't
  threaded through to the page's `Astro` global yet. Quick wire-up,
  next pass.

## What Phase 9 starts from

- The full HTTP path is in place: HMR, page rendering, endpoints,
  middleware, deploy, runtime serving.
- Error boundaries are still primitive (`Preview error: ${msg}` text
  body, 500). Phase 9 polishes these.
- The brief's `minimal-blog` fixture (acceptance criterion §11.1) can
  now be assembled — markdown + content collections + the preview
  server + deploy.
