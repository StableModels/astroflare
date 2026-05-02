# Phase 5 — HMR over WebSocket

**Goal (from §7.5 of the brief):** Hibernatable WS in the Coordinator DO,
HMR protocol messages, browser-side HMR client (~3 KB), wire
`FsService.write → Coordinator.onFileChanged → publish('hmr', …) → broadcast`,
inject HMR client script into preview HTML responses.

**Status:** the framework-side HMR pipeline lands. Hibernatable WebSocket
implementation (workerd-side) and Layer-C latency/soak tests deferred to
the host implementation phase per Phase 2.5 findings (no workerd-compatible
Executor / WS infrastructure yet in our test pool).

## What landed

### Browser HMR client (`@astroflare/runtime/src/hmr-client.ts`)

Two surfaces:
- **`installHmrClient(opts)`** — typed entrypoint tests can drive directly
  with a fake `WebSocket` constructor. Connects, listens for messages,
  triggers `location.reload()` for `update`/`prune`/`full-reload`, logs
  `error` messages without reloading.
- **`HMR_CLIENT_SOURCE`** — string constant the framework inlines into
  preview HTML responses via `<script type="module">${SRC}</script>`.
  Mirrors `installHmrClient`'s default behaviour, no imports needed.

Phase 5 strategy: **full reload on any change.** Granular hot replacement
lands in Phase 8 alongside client islands, where module-level update
semantics actually matter. SSR pages re-render server-side anyway —
`location.reload()` is the shortest path to "what you see reflects what
you wrote."

10 tests cover: each message type's reload semantics (or lack thereof),
malformed-payload tolerance, dispose, error-event recovery, default URL
construction from `location`, payload size budget (under 3 KB).

### HMR script injection (`@astroflare/preview/src/inject-hmr.ts`)

Inserts `<script type="module">…</script>` into HTML:
1. before `</head>` if present (preferred — runs before body parsing)
2. before `</body>` else (fallback)
3. appended otherwise (fragment routes)

Case-insensitive tag matching; uses *last* occurrence of the closing tag
(defensive against literal `</head>` text inside a `<pre>` block). 5 tests.

### `HmrMessage.trigger` (in `@astroflare/core`)

Added an optional `trigger?: string` field to the `update` variant —
the path the user actually touched. Existing `updates: HmrUpdate[]`
includes the trigger plus every transitively-affected module (from the
Coordinator's reverse-edge walk). The split lets listeners distinguish
"this file changed" from "this file was transitively-affected" — the
preview server uses it to filter route re-discovery (only when the
trigger is under `/src/pages/`).

`MapCoordinator.onFileChanged` populates `trigger`; existing tests pass
unchanged because the field is optional.

### Preview server HMR pipeline (`preview-server.ts`)

On first request (when route discovery runs), the server installs two
subscriptions on the coordinator's `hmr` channel:

1. **Forward to transport** — every published `HmrMessage` calls
   `host.transport.broadcastHmr(workspaceId, msg)`, fanning out to every
   connected WebSocket.
2. **Reactive route invalidation** — when an `update` message's `trigger`
   is under `/src/pages/`, re-call `router.discover(host.storage)` so
   newly-added or renamed pages become reachable without a server
   restart. The trigger-based filter is precise: a non-page file change
   that transitively-affects a page won't re-walk the router.

The `/_aflare/hmr` URL is delegated to `host.transport.acceptHmrSocket`,
which returns a `Response` with the WS upgrade attached (workerd's
`WebSocketPair` model in production; a 200 stub in `MemoryTransport`
for tests).

`createPreviewServer` returns a `dispose()` so tests can tear down
subscriptions cleanly.

Rendered HTML responses now run through `injectHmrScript(html, HMR_CLIENT_SOURCE)`
before being wrapped in `Response`. Existing exact-content assertions
in tests get a `stripHmr(body)` helper to compare the raw rendered HTML.

### Tests (52 → 67 in preview, 33 → 43 in runtime; 268 → 293 total)

15 new preview-server tests:
- HMR script injection in `<head>`, before `</body>`, appended for
  fragments
- `/_aflare/hmr` upgrade delegation, single-tenant default and custom
  workspace id
- `coordinator.onFileChanged` → transport.broadcastHmr forwarding
- multi-module change broadcasts updates for the trigger AND
  transitively-importing modules
- reactive route discovery on a `/src/pages/` trigger; not on a non-page
  trigger (the precision the `trigger` field gives us)
- `dispose()` stops further broadcasting

10 new runtime HMR-client tests covering every protocol variant.

5 new injection unit tests.

## What surprised me

1. **The HMR `update` message conflated "what changed" with "what's
   invalidated."** Phase 1's `onFileChanged` published a single payload
   listing every transitively-affected module — that's right for the
   browser (it should refetch all of them) but wrong for the route
   table (which only changes if the user added/removed a page). Adding
   the `trigger?` field is a tiny schema change with outsized clarity:
   it lets each subscriber filter for the semantic it cares about
   without coordinating a separate channel. Worth keeping in mind for
   future protocol evolution.

2. **Biome's auto-formatter wrapped my function expression as an arrow,
   which can't be `new`-ed.** The fake `WebSocket` constructor in tests
   was originally `function (url) { … }`; biome converted to
   `((url) => { … })`. Arrow functions can't be called with `new`, so
   `new Ctor(url)` failed. Lesson: when a value's role is "constructor
   target," use a `function` declaration, not an expression — arrows
   *look* equivalent but aren't. Two failing-test cycles to track this
   down.

3. **The `pre-test tsc -b` chain pays off again.** Phase 5 added the
   HMR client to the runtime package; tests reach for it via
   `import { HMR_CLIENT_SOURCE } from "@astroflare/runtime"`. Because
   `tsc -b` runs first, the dist artifact is up to date — no
   "phantom test failure because Node doesn't see the latest build."

4. **`createPreviewServer` should return a disposer.** Phase 3 returned
   just `{ fetch }`. Phase 5 added `coordinator.subscribe(...)` calls
   inside the constructor; without a disposer, leaked subscribers cross-
   contaminate tests (one test's `onFileChanged` would broadcast to
   another test's transport). Added `dispose()` and a corresponding
   test. Worth flagging in case future Phase 6/8 work adds more long-
   lived listeners — they all need to be in the `dispose()` chain.

5. **`AsyncLocalStorage` from Phase 4 is invariant under the HMR cycle.**
   The per-request context is built at request time and torn down when
   `render()` returns. HMR doesn't have to know about it — the next
   request rebuilds. Confirmation that the Phase 4 design carried us
   through Phase 5 cleanly.

## Carryovers

### Host implementation phase (when it lands)
- **Hibernatable WebSocket DO**: `host.transport.acceptHmrSocket` returns
  a real WebSocket upgrade backed by a Durable Object that uses
  `acceptWebSocket()` (the hibernatable variant). Per-connection state
  via `serializeAttachment()`. The Phase 5 `MemoryTransport` records
  broadcasts in an array — the contract is the same shape, just
  different fan-out mechanics.
- **Latency assertions**: brief calls for cold preview <300ms, warm
  <60ms, HMR roundtrip <100ms. Need a workerd-based test surface that
  doesn't go through vite-node intercept (Phase 2.5 finding).
- **Soak test**: 1000 file writes in 10 seconds; assert no missed
  updates, no socket drops. Same blocker.

### Phase 8 (client islands)
- Granular hot replacement: when only a CSS or island module changes,
  swap it without full reload. Currently every update triggers
  `location.reload()`. The HMR protocol is shape-ready (we already
  publish per-module update arrays); the runtime side just needs to
  match update entries to active modules and call their accept handlers.

### Reactive route + module-graph staleness
- A removed file should fire `Coordinator.graphRemove(path)` and
  `publish('hmr', { type: 'prune', paths: […] })`. Right now `MapCoordinator`
  has `graphRemove` but it's not wired to anything. Phase 5 doesn't need
  it (no test removes a file mid-run); a future phase wires the agent's
  `FsService.remove` → `graphRemove` + `prune`.

### Dependency note
Added `happy-dom` as a runtime devDep for future browser-shaped tests
(Phase 8 hydration). Phase 5's HMR-client tests don't actually use it —
a fake WebSocket via `EventTarget` was sufficient. Keeping the dep so
Phase 8 doesn't have to re-add it.

## Acceptance signals at phase close

- `pnpm typecheck` — green.
- `pnpm lint` — green (90 files).
- `pnpm test` — **293 tests across 25 files, all 5 pools green** (was
  268 at end of Phase 4).
- Framework boundary check — zero `cloudflare:` / `@cloudflare/` matches
  in framework packages.

## What Phase 6 starts from

- The dev-loop is reactive end-to-end (under Layer A): edit a file →
  HMR fires → browser reloads → fresh render. Multi-file `.astro`
  composition + reactive routes both work.
- HMR protocol is shape-stable (`update`/`prune`/`error`/`full-reload`
  with optional `trigger`). Phase 6 / 8 add semantics within the same
  shape — no schema break expected.
- `node:async_hooks` (used by the runtime) and `happy-dom` (added as
  devDep) are both available for any per-request or browser-shaped
  testing Phase 6 needs.
