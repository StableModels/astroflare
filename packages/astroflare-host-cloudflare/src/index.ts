// Cloudflare-only host package. Implementations land in:
//   storage.ts          — Storage over @cloudflare/shell + @cloudflare/workspace
//   executor.ts         — Executor over Worker Loader binding
//   coordinator-do.ts   — Coordinator as Durable Object
//   transport.ts        — WebSocket via DO (Hibernatable)
//   project-worker.ts   — entrypoint; wires bindings, exports DO classes
//   rpc-services.ts     — FsService, LogService WorkerEntrypoint classes
//
// All Cloudflare-specific symbols (cloudflare:workers, @cloudflare/*, WorkerStub,
// Hibernatable WS APIs, etc.) live here. The framework packages must not import
// any of those symbols — the boundary is enforced by the test in
// packages/astroflare-test-utils/test/boundary.test.ts.
export const HOST_CLOUDFLARE_VERSION = "0.0.0";
