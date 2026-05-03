# astroflare

Cloudflare-native, Astro-compatible content framework.

Astroflare runs an Astro-shaped project (`src/pages/`, `.astro`/`.md`/`.mdx`,
`astroflare.config.*`) end-to-end on Cloudflare's isolate primitives:

- **Live preview** with sub-100 ms file-change-to-pixel feedback. No bundling
  in dev — transform-on-demand inside Worker Loader / Dynamic Workers, with a
  content-addressed warm cache. HMR over Hibernatable WebSockets.
- **Production build** that produces a content-addressed artifact stored in a
  Workspace, with all routes pre-rendered and SSR routes shipped as a
  Worker module map.
- **Production runtime** that serves static HTML, hashed assets, and SSR
  routes — no Node, no Vite, no sharp, no native code anywhere.

## Status

Phases 0–11 shipped, plus Phase 2.5b which closed the original Phase 2.5
deferral list (Miniflare v4 unblock + real `WorkerdExecutor` + real
Hibernatable WS Transport + workerd-native compiler e2e + latency + soak).
**445 tests across 5 test pools.**

The framework runs end-to-end:

- **Live preview** — file-based routing, `.astro` + `.md`, multi-file
  composition, HMR over WebSocket, content-hashed compile cache, reactive
  route discovery (additions + removals), server endpoints, middleware,
  dev error overlay.
- **Tier 0 Astro surface complete** — `Astro.props/params/request/url/
  site/redirect/cookies/locals/slots`, plus `getStaticPaths()` for
  dynamic routes (`Astro.self` deferred). Component-returned `Response`
  short-circuits to a real HTTP response.
- **TypeScript throughout** — `.astro` frontmatter, `.ts` endpoints,
  `.ts` middleware. esbuild-wasm strips type syntax at compile time;
  same module runs in Node and (Phase 15+) in workerd.
- **Content collections** — `defineCollection` + Zod schemas + `getCollection` +
  `getEntry`, walking `src/content/<name>/`.
- **Deploy pipeline** — planner (with `getStaticPaths` expansion),
  render fan-out, manifest, atomic flip, runtime serving shim.
- **`examples/minimal-blog`** — exercises every Tier 0/1 capability through
  preview and deploy.

Significant carve-outs remain: the `@astroflare/host-cloudflare`
implementation (Storage, Coordinator DO, Project Worker), scoped CSS,
image transforms, TS support throughout, framework integrations,
client-island hydration, view transitions, latency / soak / coverage
gates. Each carryover lives per-phase under
[`docs/phases/`](./docs/phases/), and the next set is consolidated
in [`docs/next-phases.md`](./docs/next-phases.md).

## Layout

```
packages/
  astroflare-core/             # framework types + host interfaces + path/hash/glob primitives
  astroflare-compiler/         # .astro parser/emitter + .md compiler (remark/rehype)
  astroflare-runtime/          # render() + $component/$render ABI + HMR client
  astroflare-preview/          # router + module graph + bundler + HMR + endpoints + middleware
  astroflare-build/            # planner + render fan-out + artifact + atomic flip
  astroflare-content/          # content collections (Zod-typed, Astro-shaped surface)
  astroflare-test-utils/       # MemoryStorage + MapCoordinator + InProcessExecutor + fixtures
  astroflare-host-cloudflare/  # ONLY package allowed to import @cloudflare/* and cloudflare:
                               # (skeleton only — host implementation phase blocked on Phase 2.5)
tests/
  workerd/                     # Layer B: framework code under workerd via vitest-pool-workers
  integration/                 # Layer C: end-to-end Miniflare tests
examples/
  minimal-blog/                # acceptance §11.1 fixture — Tier 0/1 features end-to-end
```

## The framework / host boundary (load-bearing)

Framework packages — `core`, `compiler`, `runtime`, `preview`, `build` — must
not import any Cloudflare-specific symbol. Cloudflare integration lives only
in `@astroflare/host-cloudflare`. The framework receives capabilities through
five interfaces in `@astroflare/core` (`Storage`, `Executor`, `Coordinator`,
`Transport`, `Clock`/`Logger`).

This boundary is what lets the entire framework be tested in plain Node with
in-memory implementations from `@astroflare/test-utils`.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```

## License

MIT.
