/**
 * Public framework types and host interfaces.
 *
 * Defined in §5.2 of the brief. The framework receives all Cloudflare capabilities
 * through these interfaces. No file in this package, or any other framework package
 * (compiler/runtime/preview/build), may import a Cloudflare-specific symbol — see
 * acceptance criterion §11.5.
 *
 * The framework is a function `(host: Host) => AstroflareApp`. The host is the
 * tuple of the six interfaces below, supplied by `@astroflare/host-cloudflare` in
 * production and by `@astroflare/test-utils` in framework-layer tests.
 */

// -----------------------------------------------------------------------------
// 1. Storage — files + content-addressed cache (§5.2)
// -----------------------------------------------------------------------------

/**
 * Per-tenant storage. Two disjoint keyspaces:
 *
 *   - the **file** keyspace (`read`/`write`/`glob`/`stat`) holds the user's
 *     project tree as written by the agent. Paths are POSIX-style, leading "/"
 *     denotes the workspace root.
 *
 *   - the **cache** keyspace (`cacheRead`/`cacheWrite`) holds content-addressed
 *     artifacts (compiled modules, rendered HTML, deploy snapshots). Keys are
 *     opaque strings — typically the SHA-256 hex of the inputs, truncated to
 *     16 chars per §9.4. The two keyspaces never alias: `cacheWrite("foo", x)`
 *     does NOT make `read("foo")` return `x`.
 *
 * Implementations must be safe for concurrent access. The framework relies on
 * `write` being atomic (a partial read of a half-written file is a bug).
 */
export interface Storage {
	/** Read a file. Throws if missing. */
	read(path: string): Promise<Uint8Array>;
	/** Write a file atomically. Creates parent directories as needed. */
	write(path: string, bytes: Uint8Array): Promise<void>;
	/** Delete a file. No-op if missing. */
	remove(path: string): Promise<void>;
	/** Async-iterate file paths matching a glob pattern (POSIX-style globs). */
	glob(pattern: string): AsyncIterable<string>;
	/** Stat a file. Returns null if missing. `hash` is the content hash. */
	stat(path: string): Promise<FileStat | null>;
	/** Read a content-addressed artifact. Returns null on miss. */
	cacheRead(hash: string): Promise<Uint8Array | null>;
	/** Write a content-addressed artifact. Idempotent: same hash → same bytes. */
	cacheWrite(hash: string, bytes: Uint8Array): Promise<void>;
}

export interface FileStat {
	size: number;
	hash: string;
}

// -----------------------------------------------------------------------------
// 2. Executor — isolated unit of work (§5.2)
// -----------------------------------------------------------------------------

/**
 * Spawns code in a fresh isolate. In production this maps to Cloudflare's
 * Worker Loader binding (§4); in tests it maps to a `worker_threads` peer.
 *
 *   - `runOnce`   — fresh isolate every call; no cache.
 *   - `runCached` — keyed by `id`. The same `id` is guaranteed to return the
 *                   same logical result without re-spawning a cold isolate;
 *                   different `id`s spawn different isolates. The brief's
 *                   biggest perf win (§5.3): the host's `loader.get(hash, ...)`
 *                   maps directly onto this.
 *
 * Bindings are NOT forwarded into the isolate (§9.3). Tasks that need a host
 * service ask for it by name in `TaskBundle.capabilities`; the host arranges
 * for the corresponding `WorkerEntrypoint` reference to be available to the
 * task at spawn time. Phase 3+ defines the capability service contract.
 */
export interface Executor {
	runOnce<R>(task: TaskBundle, input: unknown): Promise<R>;
	runCached<R>(id: string, taskFactory: () => TaskBundle, input: unknown): Promise<R>;
}

/**
 * The code an executor spawns. `mainModule` is a key into `modules`; the
 * task's exported `default` (or named export, by host convention) is invoked
 * with `input` and returns `R`.
 *
 * The brief caps `Σ |modules[*]|` at ~256 KB (§9.1). Above that, the host
 * passes a thin entrypoint and the task fetches modules over RPC. The
 * framework should not need to care about this directly — the build/preview
 * machinery decides whether to inline or fetch based on size.
 */
export interface TaskBundle {
	mainModule: string;
	modules: Record<string, string>;
	/** Names of host-side RPC services to expose to the task. See §9.3. */
	capabilities?: string[];
}

// -----------------------------------------------------------------------------
// 3. Coordinator — long-lived per-workspace state and event hub (§5.2)
// -----------------------------------------------------------------------------

/**
 * Per-workspace coordination state. In production this is a Durable Object;
 * in tests it is an in-memory object. Owns:
 *
 *   - the **module graph** (`graphGet`/`graphPut`): the dependency DAG over
 *     a project's modules, used for transform-on-demand cache keys and HMR
 *     invalidation walks.
 *
 *   - the **change pipeline** (`onFileChanged`): called by the FS path on every
 *     write. Atomically: rehash the file, walk reverse edges, publish HMR.
 *     This is the synchronous-ordered chokepoint described in §5.4.
 *
 *   - the **pubsub bus** (`publish`/`subscribe`): used for HMR fan-out and
 *     potentially for log streaming and deploy progress events.
 */
export interface Coordinator {
	/**
	 * Notify the coordinator that a file changed. Implementations should:
	 *   1. Update the module-graph node for `path` to record the new hash.
	 *   2. Compute the set of transitively-importing modules (reverse-edge walk).
	 *   3. `publish` an HMR `update` for that set on the workspace's HMR channel.
	 *
	 * Must be safe to call concurrently. Brief §5.4: "Change detection is
	 * synchronous, ordered, and free."
	 */
	onFileChanged(path: string, hash: string): Promise<void>;

	/** Look up a node in the module graph. */
	graphGet(path: string): Promise<ModuleNode | null>;
	/** Insert or replace a node in the module graph. */
	graphPut(node: ModuleNode): Promise<void>;
	/** Remove a node and any reverse edges pointing at it. */
	graphRemove(path: string): Promise<void>;

	publish(channel: string, message: HmrMessage): Promise<void>;
	subscribe(channel: string, handler: (m: HmrMessage) => void): Subscription;
}

/**
 * A node in the module graph. Phase 4 fills the algorithms; the type lives
 * here because `Coordinator` references it across the boundary.
 *
 * `imports` and `importedBy` are resolved POSIX paths into the workspace.
 * `hash` is the SHA-256 hex of the file's bytes (full hex, not truncated —
 * truncation happens at content-addressing time, not in the graph).
 */
export interface ModuleNode {
	path: string;
	hash: string;
	imports: readonly string[];
	importedBy: readonly string[];
}

export interface Subscription {
	unsubscribe(): void;
}

// -----------------------------------------------------------------------------
// 4. Transport — browser-facing (§5.2)
// -----------------------------------------------------------------------------

/**
 * The browser-facing edge for HMR. The preview HTTP path is plain `fetch`
 * handling and does not go through `Transport`; only the WebSocket upgrade
 * + broadcast does.
 */
export interface Transport {
	/**
	 * Synchronous WebSocket upgrade response. Implementations return a
	 * `Response` with `status: 101` and a paired socket attached, exactly
	 * matching workerd's `WebSocketPair` model. Per-connection state is
	 * persisted via `serializeAttachment()` (§9.8); HMR messages survive
	 * Durable Object hibernation.
	 */
	acceptHmrSocket(req: Request, ctx: HmrSocketContext): Response;

	/**
	 * Broadcast an HMR message to every active subscriber for `workspaceId`.
	 * Idempotent for the same `(workspaceId, msg)` only at the protocol level —
	 * the network may deliver duplicates if a subscriber is reconnecting.
	 */
	broadcastHmr(workspaceId: string, msg: HmrMessage): Promise<void>;
}

export interface HmrSocketContext {
	workspaceId: string;
}

/** Phase 5 fills out edge cases (granular hot updates, error overlays). */
export type HmrMessage =
	| { type: "update"; updates: HmrUpdate[] }
	| { type: "prune"; paths: readonly string[] }
	| { type: "error"; error: HmrError }
	| { type: "full-reload"; reason: string };

export interface HmrUpdate {
	/** Workspace path of the updated module. */
	path: string;
	/** New content-addressed hash, used to invalidate the browser's `?v=` URL. */
	hash: string;
	/** Whether this update is for a CSS module (different hot-replace strategy). */
	kind: "module" | "css";
}

export interface HmrError {
	message: string;
	path?: string;
	line?: number;
	column?: number;
	stack?: string;
}

// -----------------------------------------------------------------------------
// 5. Clock + Logger — trivially stubbable (§5.2)
// -----------------------------------------------------------------------------

/** A monotonic-ish wall clock. Tests pin time by injecting a fake. */
export interface Clock {
	now(): number;
}

/**
 * Structured event sink. The framework never formats messages itself —
 * everything goes through `event(name, fields)`. The host decides whether
 * to ship to a logging service, drop, or buffer.
 */
export interface Logger {
	event(name: string, fields: Record<string, unknown>): void;
}

// -----------------------------------------------------------------------------
// Host bundle + AstroflareApp
// -----------------------------------------------------------------------------

/**
 * The full set of host capabilities the framework needs. Constructed by the
 * host package and passed to `createApp(config, host)`.
 */
export interface Host {
	storage: Storage;
	executor: Executor;
	coordinator: Coordinator;
	transport: Transport;
	clock: Clock;
	logger: Logger;
}

/**
 * The framework as a value: the result of mounting the framework over a host.
 * Phase 3+ fleshes out the methods. Kept narrow for now so types compile
 * without speculation.
 */
export interface AstroflareApp {
	/**
	 * Handle an HTTP request to the live preview surface (request → compile
	 * via `Executor.runCached(contentHash)` → render → response). No bundling.
	 */
	handlePreviewRequest(req: Request): Promise<Response>;

	/**
	 * Handle a WebSocket upgrade for HMR. Returns the upgrade `Response`.
	 */
	handleHmrUpgrade(req: Request): Response;

	/**
	 * Notify the framework that a file changed. The agent's `FsService.write`
	 * RPC calls this synchronously after the workspace write succeeds (§5.4).
	 * Implementations propagate to the coordinator and trigger HMR fan-out.
	 */
	notifyFileChanged(path: string, hash: string): Promise<void>;
}

// -----------------------------------------------------------------------------
// AstroGlobal — the user-visible `Astro.*` API surface (Tier 0)
// -----------------------------------------------------------------------------

/**
 * The `Astro` object available to every `.astro` component's frontmatter and
 * template. Tier 0 surface (per §3 of the brief). Phase 3 covers props,
 * params, request, url, redirect, site. Cookies, locals, slots, self deferred.
 */
export interface AstroGlobal<P = Record<string, unknown>> {
	/** Props passed to this component (route params from getStaticPaths or parent's render). */
	props: P;
	/** URL parameters from the matched route, e.g. `[slug]` → `{ slug: "..." }`. */
	params: Record<string, string>;
	/** The incoming `Request`. */
	request: Request;
	/** Parsed `URL` (same as `new URL(request.url)`). */
	url: URL;
	/** Site origin from config (`undefined` if not configured). */
	site?: string;
	/** Returns a `Response` that redirects to `to` with `status` (302 default). */
	redirect(to: string, status?: 301 | 302 | 303 | 307 | 308): Response;
}

/**
 * Context the framework supplies to `render()` to build the AstroGlobal.
 */
export interface RenderContext<P = Record<string, unknown>> {
	props: P;
	params: Record<string, string>;
	request: Request;
	url: URL;
	site?: string;
}

// -----------------------------------------------------------------------------
// Configuration (Astro-shaped — see §3 Tier 0 / §9.10)
// -----------------------------------------------------------------------------

/**
 * Astroflare project configuration. Astro-shaped: users author `defineConfig({...})`
 * in `astroflare.config.{ts,mjs,js}`. Phase 6+ will grow the schema as Tier 1
 * features land. Until then, `unknown` typed integration objects are accepted.
 */
export interface AstroflareConfig {
	/** Site origin URL (used for canonical URLs, sitemap, RSS). */
	site?: string;
	/** Public base path (default "/"). */
	base?: string;
	/** Output mode. Phase 7+ wires up "static" vs "hybrid" vs "server". */
	output?: "static" | "hybrid" | "server";
	/** Enabled integrations. Phase 8+ defines the integration contract. */
	integrations?: readonly unknown[];
	/** Markdown plugin chain. Phase 6+ defines the schema. */
	markdown?: unknown;
	/** Vite is forbidden (§10) — kept here only so we can throw a clear error
	 *  if someone copies an Astro config that includes it. */
	vite?: never;
}

/**
 * Helper used in user config files: `export default defineConfig({...})`.
 * Identity at runtime, type-narrowing at edit time.
 */
export function defineConfig(config: AstroflareConfig): AstroflareConfig {
	return config;
}

// -----------------------------------------------------------------------------
// Misc
// -----------------------------------------------------------------------------

export type AstroflareVersion = "0.0.0";
export const ASTROFLARE_VERSION: AstroflareVersion = "0.0.0";
