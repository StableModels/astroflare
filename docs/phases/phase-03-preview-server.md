# Phase 3 — server runtime + first end-to-end render

**Goal (from §7.3 of the brief):** A `render()` function in `@astroflare/runtime`
that takes a compiled module and produces HTML; a minimal preview server in
`@astroflare/preview` that handles request → route lookup → compile via
`Executor.runCached` → render → return HTML. **No HMR, no module URL rewriting,
no incremental graph** — those are Phase 4+.

**Status:** complete. Layer A end-to-end tests cover routing, the `Astro.*`
surface (params, url, request, site), HTML escaping through the full stack,
executor caching, and error responses. Layer C (Miniflare integration with
real host) deferred per Phase 2.5 findings.

## What landed

### `AstroGlobal` (in `@astroflare/core`)

Tier 0 surface (per §3 of the brief), built once per request and passed to the
component:

| Field | Status |
|---|---|
| `Astro.props` | ✅ |
| `Astro.params` | ✅ |
| `Astro.request` | ✅ |
| `Astro.url` | ✅ |
| `Astro.site` | ✅ |
| `Astro.redirect(to, status)` | ✅ |
| `Astro.cookies` | deferred (Phase 6+) |
| `Astro.locals` | deferred (Phase 8 middleware) |
| `Astro.slots` | deferred (slot rendering currently goes through `$$slots` in compiled output) |
| `Astro.self` | deferred (recursive components) |
| `getStaticPaths()` | deferred (Phase 7 static generation) |

`RenderContext<P>` is the framework's input shape — props, params, request,
url, site. Tests build one directly to drive `render()`; in production the
preview server constructs it from each incoming `Request`.

### `render(component, context, options)` (in `@astroflare/runtime`)

The framework-facing entrypoint. Builds the `AstroGlobal`, invokes the
component as `Component({ Astro, ...props }, slots)`, awaits the resulting
`RawHtml`, returns the final HTML string via `renderToString`. Deliberately
small — the heavy lifting is in the compiler-emitted ABI (every tag,
expression, slot, and component reference is already a runtime call by the
time `render` runs).

`createAstroGlobal(context)` is exported for tests, integrations, and the
build pipeline.

### File-based router (in `@astroflare/preview/src/router.ts`)

Walks `Storage.glob("/src/pages/**/*.astro")`, builds a route table, matches
URL pathnames against it.

Supported (Tier 0):
- `index.astro` → `/`
- `about.astro` → `/about`
- `posts/[slug].astro` → `/posts/<slug>` with `params.slug`
- Trailing-slash tolerance on requests
- Static routes win priority over dynamic ones (`/about` beats `/[slug]`)

Deferred:
- catchall `[...rest]`
- non-`.astro` extensions (md/mdx is Phase 6, .ts/.js endpoints are Phase 8)
- group folders (`(marketing)/about.astro` style)

13 unit tests cover the router; another 11 e2e tests exercise it through the
preview server.

### `createPreviewServer({ config, host, runtimeImport? })`

Public factory returning `{ fetch(req): Promise<Response> }`. Per request:

1. **Lazy route discovery** on first request, then cached. (Phase 4 wires
   reactive re-discovery via `Coordinator.onFileChanged`.)
2. **Match URL pathname** to a route. 404 if no match.
3. **Read source bytes** from `host.storage`.
4. **Content-hash the source** mixed with the compiler version (per §9.4) —
   this is the executor's `runCached` id.
5. **`host.executor.runCached(id, factory, input)`** — factory builds a
   `TaskBundle` containing the compiled `.astro` module + a thin wrapper that
   imports `render` and default-exports `(input) => render(Component, input)`.
   Input is the per-request `RenderContext`. Returns the rendered HTML string.
6. **Wrap in `Response`** with `content-type: text/html;charset=utf-8`.

Errors anywhere in the pipeline return 500 with the exception message; 404s
log `preview.notfound` and successful renders log `preview.render` with
`{ pathname, filePath, cacheId, ms }` so tests and production telemetry can
assert on cache behaviour.

### Tests (25 new, 223 total)

End-to-end flow under `InProcessExecutor` + `MemoryStorage` + the
`dist/index.js` `file://` URL pattern:

- routing: 404 on unmatched, `/`, static nested, trailing slash
- `Astro.params` for `[slug]` dynamic routes (with URI decoding)
- `Astro.url`, `Astro.request`, `Astro.site` populated correctly
- HTML escaping end-to-end (`<bob>` in URL → `&lt;bob&gt;` in output)
- executor cache: same route hits same cacheId; different routes get
  different cacheIds
- error path: compile error returns 500; storage failure returns 500

## What surprised me

1. **The compiler's split runtime exports cost a small reorg.** The compiled
   `.astro` modules import `$component`, `$render`, etc. from
   `@astroflare/runtime/internal`. The framework wrapper that invokes the
   component imports `render` from `@astroflare/runtime` (the index, which
   re-exports both). For tests, both have to be resolvable from the same
   `runtimeImport` URL — that means pointing at `dist/index.js`, not
   `dist/internal.js`, since `index.js` re-exports both. Worth a comment in
   the test fixture; bit me once.

2. **Routing trailing-slash semantics are touchy.** Astro defaults to
   "always" mode (always include trailing slash). I chose "ignore" for
   Phase 3 (match either form, no redirect). Configuration belongs to
   `AstroflareConfig.trailingSlash` later; document the current behaviour
   so we don't regress when adding the option.

3. **Lazy route discovery interacts badly with one error test I wrote.**
   The original test expected 500 when the storage read fails for a route
   that "exists" — but routes are discovered on first request, so deleting
   the file before the first request just makes route discovery skip it
   (→ 404). Fixed by triggering route discovery first, then deleting. Worth
   noting because the same trap will recur in Phase 4 when invalidation
   becomes reactive.

4. **The `RenderContext` shape doesn't fit through a serialisation
   boundary.** `Request` is in there, and `Request` isn't structured-cloneable
   across worker boundaries (it bears streams). For Phase 3 with
   `InProcessExecutor` (everything in-process), the executor passes by
   reference and `Request` survives. For a real Worker Loader Executor,
   we'd need to marshal request shape (method, url, headers, body) and
   reconstruct on the other side. That's marshalling work for Phase 4+
   that I'm flagging now so the host implementer doesn't trip on it.

5. **Astro components currently get props as TWO things at once.** The
   compiler emits `({ Astro, ...$$props }, $$slots) => ...`. Inside,
   `Astro.props` and `$$props` are the same object. Users use
   `Astro.props.x`. I considered removing the spread (since `$$props` is
   never read in user code) but kept it because (a) the compiler change
   would be invasive across emitter/tests, and (b) keeping `$$props` in
   scope might be useful for future internal compiler features (slot
   debugging, etc.). Mild redundancy.

## Carryovers

### Phase 4 (preview module graph, URL rewriting)
- **Multi-file `.astro` support.** Right now `import Layout from "./Foo.astro"`
  in frontmatter doesn't resolve — the executor's tmp dir doesn't have
  `.astro` extension support. Phase 4's URL rewriter handles this: imports
  get rewritten to `/_aflare/mod?p=<path>&v=<hash>` (browser-side) or to
  the bundle's content-addressed module map (executor-side).
- **Reactive route discovery.** Currently routes are discovered on first
  request and cached forever. Phase 4 wires `Coordinator.onFileChanged` →
  invalidate route table when a file under `/src/pages/` is added/removed.
- **Content-addressed compile cache persistence** via `Storage.cacheRead/Write`.
  Right now the executor's cache is in-memory; restarting loses everything.
- **HMR.** Phase 5; the preview server already broadcasts `preview.render`
  log events that the HMR coordinator can subscribe to.

### Phase 4+ (host implementation)
- **Layer C / Miniflare integration test.** The brief calls for a real
  `@cloudflare/host-cloudflare` + Worker Loader + Workspace integration
  test. Phase 2.5 found that Worker Loader isn't exposed by Miniflare. The
  honest plan: build the host's Executor on top of whatever workerd-direct
  approach (raw capnp config + `workerd serve`, or a workerLoader binding
  patch on Miniflare) we settle on, then this Layer C test follows. Phase 3
  ships Layer A only.

### `Astro.*` surface gaps
- Cookies (Phase 6+) — needs request-cookie parsing + response-cookie writing.
- Locals (Phase 8 middleware) — middleware sets `Astro.locals`.
- `Astro.slots` (Phase 8) — render slots imperatively from a component's body.
- `Astro.self` (Phase 8) — recursive components.

### `Astro.redirect` not yet integrated into the response pipeline
The framework constructs the redirect Response, but the preview server
doesn't notice when the user returns one — it always wraps in a 200. Need
to detect `instanceof Response` from the component's output and pass it
through. Quick fix; deferred for Phase 4 alongside other Astro.* polish.

## Acceptance signals at phase close

- `pnpm typecheck` — green.
- `pnpm lint` — green (79 files).
- `pnpm test` — **223 tests across 20 files, all 5 pools green** (was 199
  at end of Phase 2.5).
- Framework boundary check — zero `cloudflare:` / `@cloudflare/` matches
  in framework packages.

## What Phase 4 starts from

- The preview server is the right shape for layering on the module graph:
  every per-request flow already goes through compile cache via
  `Executor.runCached(contentHash, ...)`, so adding URL-rewriting just
  requires a transform pass on the emitted code's import statements before
  the bundle is finalised.
- The router knows which file each route maps to. Reactive re-discovery
  plugs into `Coordinator.onFileChanged` directly.
- The executor caches by content+config hash, so a file edit naturally
  produces a new cache id and a fresh compile/render path. HMR (Phase 5)
  notifies the browser to refetch, cycle complete.
