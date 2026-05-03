# Phase 2.5 — workerd test pool + honest harness boundaries

**Goal:** address the test-harness concerns raised at the end of Phase 2 —
the InProcessExecutor doesn't faithfully simulate Worker Loader, Vite is in
the runtime path, runtime tests live in the wrong pool, the `dist/internal.js`
file:// URL hack is brittle.

**Status:** scope reduced from the original plan after investigation. The
runtime tests moved to Layer B (workerd via vitest-pool-workers) — small,
high-value win. The bigger goals (a real `WorkerdExecutor`, multi-module
.astro composition tests) are blocked by infrastructure constraints we
discovered along the way; they belong to Phase 3+'s host implementation work.

## What we set out to do

1. Build a `WorkerdExecutor` that runs `TaskBundle`s in real workerd isolates
   via Cloudflare's Worker Loader binding.
2. Move runtime tests to Layer B so they run under workerd, not Node.
3. Migrate the compiler's end-to-end tests to use `WorkerdExecutor`,
   re-enabling multi-module composition and removing the `dist/internal.js`
   file:// URL hack.

## What we discovered (the architecturally important part)

### 1. Worker Loader exists in workerd 2025-07-18 but Miniflare 3.20250718 doesn't expose it as a config option.

- **workerd's capnp config:** the `workerLoader :group` binding type is
  defined in `workerd.capnp` (verified via `grep` against the binary's
  schema). Production-ready.
- **`@cloudflare/workers-types@4.20260502.1`:** declares a `WorkerLoader`
  TypeScript interface with `load(code)` and `get(name, getCode)` exactly
  matching the brief's §4 spec.
- **Miniflare 3.20250718's `CoreOptionsSchema`:** has `bindings`, `wasmBindings`,
  `textBlobBindings`, `dataBlobBindings`, `serviceBindings`, `wrappedBindings`,
  `unsafeEvalBinding`, `unsafeUseModuleFallbackService`, `unsafeDirectSockets` —
  but **no `workerLoaders` field.** The capnp `Worker_Binding_WorkerLoader`
  struct is bundled (Miniflare knows how to *receive* the binding type), but
  Miniflare doesn't *emit* the binding from user options.

The path to a real `WorkerdExecutor` therefore goes one of:
- bypass Miniflare and run `workerd serve <config.capnp>` directly with
  hand-written capnp;
- monkey-patch / fork Miniflare to add a `workerLoaders` option;
- wait for Miniflare to expose it natively.

All three exceed Phase 2.5's scope.

### 2. Vite is in the runtime path even inside vitest-pool-workers' worker.

The original plan was to use dynamic `import("data:text/javascript;base64,...")`
inside a Layer B test as a cheap "execute compiled .astro inside workerd"
mechanism. **It doesn't work:** vitest-pool-workers boots the test worker
with **vite-node as the module loader**, and vite-node intercepts every
dynamic `import()`. When given a `data:` URL it tries to resolve it as a
relative path through its module fallback service, producing errors like:

```
No such module ".../vite-node/dist/data:text/javascript;base64,..."
```

This is a fundamental property of vitest-pool-workers, not a configuration
mistake. **Vite isn't only in the test orchestration — it's the in-worker
module resolver too.** The "Layer B = Vite-free runtime path" assumption I
made when proposing Phase 2.5 was wrong.

The POC test (`tests/workerd/poc-data-url.test.ts`, since deleted) crisply
demonstrated this. The trace points at vite-node's `client.mjs` loading the
data URL via a fallback service.

### 3. Static imports inside the workerd pool work fine.

The path that *does* work in Layer B: import framework code statically
(`import { $render } from "@astroflare/runtime/internal"`), then exercise it.
vite-node resolves bare specifiers via package.json correctly; only dynamic
imports of arbitrary strings break.

## What landed

### `tests/workerd/` workspace project

A new test-only workspace member (sibling of `tests/integration/`). Configured
with `@cloudflare/vitest-pool-workers` so tests run inside real workerd. Wired
into `vitest.workspace.ts` so `pnpm test` exercises it. Has its own
`harness.ts`, `wrangler.toml`, `vitest.config.ts`, `tsconfig.json` — the same
shape as `tests/integration/` but for narrower per-package workerd tests.

Justification for new package vs. adding workerd configs to each framework
package: keeps Cloudflare deps (`@cloudflare/vitest-pool-workers`,
`@cloudflare/workers-types`, `wrangler`) out of the framework packages'
package.json. Acceptance criterion §11.5 is about `/src` imports specifically,
but keeping framework packages slim is a virtue beyond what the grep checks.

### Runtime tests under workerd (18 new tests)

`tests/workerd/runtime.test.ts` mirrors the Node-side runtime tests:
- `$escape` (5 metacharacter coverage, null/undefined/false/true normalisation,
  RawHtml passthrough)
- `$render` (RawHtml return shape, primitive escaping, no double-escape on
  nested results, Promise awaiting, array flattening)
- `$component` + `$renderComponent` + `$renderSlot` (slot routing + fallback)
- `$attrPair`, `$spreadAttrs`, `$defineVars`, `$hydrationMarker`
- `renderToString`
- workerd-vs-Node sanity (`globalThis.crypto.subtle.digest`, `TextEncoder`,
  `structuredClone`)

All 18 pass. The runtime behaves identically under workerd and Node — exactly
what we want, and exactly what we couldn't *demonstrate* before this phase.

## What did NOT land

### `WorkerdExecutor`
Blocked on Miniflare's lack of Worker Loader config. The right next step is
to wait for the host implementation (Phase 3's `@astroflare/host-cloudflare`
needs a real Worker Loader Executor in production anyway), and at that point
we have a natural test seam: the host's Executor IS the executor we'd
otherwise have built standalone here.

### Compiler e2e tests on Layer B
Blocked on vite-node's dynamic-import interception. The Phase 2 e2e tests
remain in Node (Layer A), still using `InProcessExecutor` + the `dist/internal.js`
absolute file:// URL. We could replace the file:// URL with a `new Function`-
based loader that strips the runtime import line and rebinds the symbols, but
that's uglier than what we have for marginal gain.

### `dist/internal.js` file:// URL hack
Still there. Not addressed.

## What surprised me

1. **Miniflare's surface lags workerd's.** Worker Loader has been in workerd
   capnp config for a while; Miniflare hasn't surfaced it. This isn't a bug
   in either project — it's just the natural lag between a runtime feature
   landing and the framework that wraps it exposing user-facing config.
   Practical implication: if Astroflare wants to use a workerd binding type
   that's stable in capnp but not in Miniflare, we either bypass Miniflare
   (workerd direct) or we wait. The host package (Phase 3+) will need to
   make this call eventually.

2. **vitest-pool-workers' "Vite-free workerd" reputation is partially
   misleading.** The test code does run inside workerd (and that's a real
   improvement over plain Node tests — Web API correctness, etc.), but the
   *module resolver inside that workerd* is vite-node, not workerd's native
   resolver. So "vitest-pool-workers gives you workerd-shaped tests" is true
   for runtime semantics but NOT for module loading semantics. Anything that
   tests dynamic loading needs a different tool.

3. **The honest answer to "should we rely on Vite at all" is: yes, in the
   test orchestration; no, in production.** The brief's §10 "no Vite anywhere"
   is unambiguously about the product. Vitest is named in §7.0 as the test
   runner; vitest is Vite. There's no reasonable way to have isolate-shaped
   testing of a CF-native framework without something Vite-flavoured in the
   loop right now. The right discipline is: every Vite intercept is a flag
   to interrogate ("is this hiding a real bug, or just an artifact of the
   harness?"), not a bug to refactor away.

4. **The existing `InProcessExecutor` is OK for what it does.** The Phase 2
   complaint was "it doesn't faithfully simulate Worker Loader." True, but
   the things it gives us — fresh module record per call, deterministic
   caching by id — are correct *for the framework-level invariants the brief
   tests demanded*. It's the unit-test substrate; isolate-faithfulness is
   the host's tests' job.

## Carryovers

### Phase 3 (host implementation)
The `@astroflare/host-cloudflare` package will implement a real `Executor`
backed by Worker Loader. That implementation, *not a separate test
executor*, becomes the Layer B/C executor for compiler/preview/build e2e
tests once it lands. At that point:
- Multi-module .astro composition gets tested for real.
- `dist/internal.js` file:// URL hack goes away (compiled modules are part
  of `WorkerCode.modules`, not loaded via Node's resolver).
- Production parity is maximal — the same Executor code path runs in tests
  and prod.

### Phase 4 (preview module graph)
- URL-rewriter handles inter-`.astro` imports. Tests of multi-module
  composition naturally fall out, since no module loading goes through
  Node anymore.

### Persistent observation: the Phase 1 retro flagged that `InProcessExecutor`
gives "module isolation, not isolate isolation." That trade-off remains.
The retro language is correct — keep it.

## Acceptance signals at phase close

- `pnpm typecheck` — green.
- `pnpm lint` — green (74 files).
- `pnpm test` — **199 tests across 18 files, all 5 pools green** (Layer A
  node + new workerd pool + host-cloudflare + integration). Was 181 at end
  of Phase 2.
- Framework boundary check — zero `cloudflare:` / `@cloudflare/` matches in
  framework packages.

## What Phase 3 starts from

- `tests/workerd/` is the home for any framework-package code that needs
  Layer B coverage. Add files; they run automatically.
- The runtime ABI is verified to behave identically under workerd and Node
  — no Web Crypto / TextEncoder / Promise scheduling surprises waiting for
  the host implementation.
- Honest scope on what's testable today: dynamic module loading needs a
  real Executor (host's), not a test fake.
