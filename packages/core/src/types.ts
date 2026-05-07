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
// 1. Site — read-only project files capability (Phase 26)
// -----------------------------------------------------------------------------

/**
 * Per-site read-only file capability. The host supplies an implementation
 * (typically wrapping a `@cloudflare/shell` `Workspace` inside a host-owned
 * Durable Object); the framework consumes it for compile + render.
 *
 * Paths are POSIX-style with a leading `/` denoting the workspace root.
 * `hash` is the SHA-256 hex of the file's bytes.
 *
 * The interface is deliberately narrow — three methods only. Mutation is the
 * host's concern (it owns when/how files are written; e.g. an IDE write, an
 * AI agent message, a `git pull`). Change notifications flow into the
 * framework via the host calling `coordinator.notifyChanged(event)` after a
 * write, not through `Site` itself. The compile-cache keyspace is a separate
 * `Cache` interface (below).
 */
export interface Site {
	/** Read a file's bytes. Returns `null` if missing. */
	readFile(path: string): Promise<Uint8Array | null>;
	/** File metadata. Returns `null` if missing. */
	statFile(path: string): Promise<FileStat | null>;
	/** Async-iterate paths matching a POSIX-style glob. */
	glob(pattern: string): AsyncIterable<string>;
}

/**
 * What the host calls `coordinator.notifyChanged` with after a write.
 * The framework rehashes the module graph, walks reverse edges, and
 * publishes HMR.
 */
export type SiteChangeEvent =
	| { kind: "write"; path: string; hash: string }
	| { kind: "delete"; path: string };

export interface FileStat {
	size: number;
	hash: string;
}

// -----------------------------------------------------------------------------
// 1b. Cache — content-addressed compile cache (Phase 26)
// -----------------------------------------------------------------------------

/**
 * Content-addressed compile cache. Decoupled from `Site` so the host can
 * back files and cache with different storage (e.g. SiteDO sqlite for files,
 * R2 for cache, or both in sqlite). Used only by Mode A (preview); Mode B's
 * deploy artifact storage is a separate `Snapshots` concern.
 *
 * Keys are opaque hex strings — typically SHA-256 of the source bytes,
 * truncated per §9.4. Implementations must be idempotent: `put(hash, x)`
 * twice with the same `hash` is fine.
 */
export interface Cache {
	get(hash: string): Promise<Uint8Array | null>;
	put(hash: string, bytes: Uint8Array): Promise<void>;
}

// -----------------------------------------------------------------------------
// 1d. Snapshots — versioned static deploy artifacts (Phase 26b)
// -----------------------------------------------------------------------------

/**
 * One file inside a snapshot. The build emits a stream of these; the
 * `SnapshotSink` writes them; `Snapshots.read` returns them.
 *
 * Replaces what `DeployManifestEntry` + the rendered-HTML byte stream
 * carried in two pieces. Now they're coupled per-route — no separate
 * manifest persisted; each entry carries enough metadata to serve.
 */
export interface SnapshotEntry {
	/** Site-relative URL path the route serves (e.g. `/`, `/about`, `/blog/p1`). */
	route: string;
	/** Rendered bytes. */
	bytes: Uint8Array;
	/** MIME content-type (e.g. `text/html;charset=utf-8`). */
	contentType: string;
	/** SHA-256 of the bytes, hex. */
	hash: string;
}

/**
 * Per-page failure surfaced by `buildSite({ continueOnError: true })` in
 * place of the throw the default mode performs. Lets agent-facing build
 * loops collect every broken page in one pass instead of re-running the
 * build after each fix.
 *
 *   - `compile` failures skip the whole page (one error per source path).
 *   - `getStaticPaths` failures skip the whole dynamic route (we can't
 *     enumerate inner entries when the enumerator itself didn't run).
 *   - `render` failures are localised — one error per failing
 *     `{ params, props }` entry; sibling entries from the same
 *     `getStaticPaths` may render fine.
 *
 * Carries structured location + source-context fields so downstream tools
 * (LLM agents, IDE error overlays, CI annotators) can target a fix instead
 * of guessing from a string. The pre-formatted `message` is preserved for
 * straight-to-stderr printing; the structured fields below are populated
 * from the same underlying diagnostic so consumers can pick whichever
 * shape is useful.
 */
export interface SnapshotError {
	/** Discriminator — distinguishes from `SnapshotEntry`. */
	kind: "error";
	/** Workspace path of the page that failed. Always set. */
	sourcePath: string;
	/** Resolved route URL, when known (set for render failures, not for compile). */
	route?: string;
	/** Per-getStaticPaths-entry params, when known (set for dynamic-route render failures). */
	params?: Record<string, string>;
	/** Phase that surfaced the failure. */
	phase: "compile" | "getStaticPaths" | "render";
	/**
	 * Pre-formatted, human-readable message — already prefixed with phase
	 * + `sourcePath` and (for compile failures) line:column. Suitable for
	 * direct printing; keep `detail`/`location` for programmatic use.
	 */
	message: string;
	/**
	 * The underlying error message without the framework's `buildSite: …
	 * for <path>:` prefix or location suffix. Useful when the consumer
	 * wants to render its own message shape.
	 */
	detail?: string;
	/**
	 * 1-based line + column + 0-based byte offset in `sourcePath` where
	 * the error originates. Set for compile failures (sourced from the
	 * compiler's own diagnostics). Render / getStaticPaths failures don't
	 * carry one yet — the underlying JS stack frame points at the
	 * compiled module, not the user's `.astro`, and source-map
	 * remapping is a follow-up.
	 */
	location?: SnapshotErrorLocation;
	/**
	 * The specific source text the compiler flagged — `source.slice(offset,
	 * end.offset)` — trimmed at the first newline so multi-line spans
	 * don't dump half the file into the field. `null`/absent when the
	 * underlying diagnostic didn't include an `end` location.
	 */
	snippet?: string;
	/**
	 * Pre-formatted multi-line excerpt of the source surrounding `location`
	 * with line numbers and a caret pointer at the offending column.
	 * Mirrors the `babel-code-frame` / `tsc` output shape so agents and
	 * IDEs can either print it as-is or parse it back via the structured
	 * fields. Absent when no `location` is available.
	 */
	codeFrame?: SnapshotErrorCodeFrame;
	/**
	 * Stack trace from the underlying JS error. Set for render and
	 * `getStaticPaths` failures (the user-supplied function threw); the
	 * frames reference the compiled module, not the original `.astro`,
	 * but the message + module path narrow the cause.
	 */
	stack?: string;
	/**
	 * Every diagnostic the parser produced for this page. Compile errors
	 * commonly surface multiple issues in one pass (e.g. one unclosed
	 * expression that confuses the rest of the file); the canonical
	 * `message` / `location` reflect the first, but consumers that want to
	 * fix all of them in one go iterate this list.
	 */
	diagnostics?: readonly SnapshotErrorDiagnostic[];
	/** Original error for richer diagnostics; opt-in for consumers. */
	cause?: unknown;
}

/** 1-based line + column + 0-based byte offset, with optional span end. */
export interface SnapshotErrorLocation {
	line: number;
	column: number;
	offset: number;
	end?: {
		line: number;
		column: number;
		offset: number;
	};
}

/**
 * Pre-formatted code excerpt around an error location.
 *
 * `text` is the printable multi-line excerpt with line numbers and a caret
 * line under the offending column. The structured fields (`startLine` /
 * `endLine` / `highlightLine` / `highlightColumn` / `highlightLength`) let
 * tools render their own framing if the canned text doesn't fit.
 */
export interface SnapshotErrorCodeFrame {
	text: string;
	startLine: number;
	endLine: number;
	highlightLine: number;
	highlightColumn: number;
	highlightLength: number;
}

/**
 * One parser/compiler diagnostic. The first entry's fields are duplicated
 * onto the `SnapshotError` itself for consumers that only care about the
 * primary cause; the array carries the full set so multi-error fixes can
 * batch.
 */
export interface SnapshotErrorDiagnostic {
	message: string;
	location: SnapshotErrorLocation;
	snippet?: string;
	codeFrame?: SnapshotErrorCodeFrame;
}

/**
 * Discriminated union yielded by `buildSite({ continueOnError: true })`.
 * Default-mode callers (no flag) keep the existing
 * `AsyncIterable<SnapshotEntry>` shape — narrow on `"bytes" in out` (or
 * `out.kind === "error"`) when consuming the diagnostic mode.
 */
export type BuildSiteOutput = SnapshotEntry | SnapshotError;

/**
 * Read-only view of stored snapshots — what the serve handler talks to.
 * Concrete implementations: `R2Snapshots` (host-cloudflare),
 * `LocalSnapshots` (Node-side helper for tests / CLI), `MemorySnapshots`
 * (test fakes).
 */
export interface Snapshots {
	/** Read one entry from a specific snapshot. Returns `null` on miss. */
	read(snapshotHash: string, route: string): Promise<SnapshotEntry | null>;
	/** Hash of the current (active) snapshot, or `null` if no deploy yet. */
	current(): Promise<string | null>;
	/** All snapshot hashes in storage. Used for rollback UIs / GC. */
	list(): Promise<readonly string[]>;
}

/**
 * Write-side counterpart to `Snapshots`. The build pipeline pipes
 * `SnapshotEntry`s through here, then commits to flip `current`.
 */
export interface SnapshotSink {
	/** Write a single entry into the staging area for `snapshotHash`. */
	put(snapshotHash: string, entry: SnapshotEntry): Promise<void>;
	/**
	 * Atomically promote `snapshotHash` to current. Implementations write
	 * the equivalent of `<prefix>current` last so partial writes never
	 * leave an inconsistent active deploy.
	 */
	commit(snapshotHash: string): Promise<void>;
	/**
	 * Best-effort cleanup of partial writes for `snapshotHash` if a build
	 * fails midway. Implementations may no-op (R2 keeps the partial files
	 * harmlessly until GC).
	 */
	abort(snapshotHash: string): Promise<void>;
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

	/**
	 * Notify the coordinator that a file was removed. Implementations should
	 * collect the set of transitively-importing modules first (because the
	 * graph node is about to disappear), then `graphRemove(path)`, then
	 * publish an HMR `prune` whose `paths` is `[path, ...transitiveImporters]`
	 * — every module the browser may have cached that's now stale.
	 */
	onFileRemoved(path: string): Promise<void>;

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
	 * WebSocket upgrade response. Returns `Response` (or `Promise<Response>`)
	 * with `status: 101` and a paired socket attached, matching workerd's
	 * `WebSocketPair` model. Per-connection state is persisted via
	 * `serializeAttachment()` (§9.8); HMR messages survive Durable Object
	 * hibernation.
	 *
	 * Async return is needed for DO-routed transports (the upgrade has to
	 * round-trip into a Durable Object via `stub.fetch`); in-memory test
	 * transports return sync. Callers always `await` it.
	 */
	acceptHmrSocket(req: Request, ctx: HmrSocketContext): Response | Promise<Response>;

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
	| {
			type: "update";
			/** Path the user actually touched. Matches one entry in `updates`,
			 *  but is split out so listeners can distinguish "this file changed"
			 *  from "this file was transitively-affected." */
			trigger?: string;
			updates: HmrUpdate[];
	  }
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
// 6. ImageService — image asset metadata + URL resolution (Phase 13)
// -----------------------------------------------------------------------------

/**
 * Asset pipeline capability. Resolves image imports at compile time —
 * `import logo from "./logo.png"` becomes a literal `ImageMetadata` the
 * `<Image>` runtime component renders into HTML.
 *
 * Production: backed by Cloudflare Images binding (Phase 15). Tests:
 * `MemoryImageService` with hand-supplied metadata.
 *
 * The framework calls into ImageService at compile time only. The runtime
 * `<Image>` component never reaches into the host — it consumes the
 * metadata literal the compiler emitted. This keeps the §11.5 boundary
 * intact: framework code never imports `cloudflare:`.
 */
export interface ImageService {
	/**
	 * Look up metadata for an image at the given workspace path. The path
	 * is the resolved import target (e.g. `/src/assets/logo.png`).
	 * Implementations parse PNG/JPEG/etc. headers to read width/height.
	 */
	getMetadata(path: string): Promise<ImageMetadata>;
}

/**
 * The minimum metadata `<Image>` and `<Picture>` need at render time.
 * `src` is a content-addressed URL the framework's deploy server / preview
 * server will recognise; `width` / `height` populate the `<img>` attrs to
 * prevent layout shift.
 */
export interface ImageMetadata {
	/** Hashed URL the runtime emits as `<img src="…">`. */
	src: string;
	/** Pixel width of the source image, if known. */
	width?: number;
	/** Pixel height of the source image, if known. */
	height?: number;
	/** Image format hint — `"png" | "jpg" | "webp" | "gif" | "svg" | …`. */
	format?: string;
}

// -----------------------------------------------------------------------------
// Host bundle + AstroflareApp
// -----------------------------------------------------------------------------

/**
 * The full set of host capabilities the framework needs. Constructed by the
 * host package and passed to `createApp(config, host)`.
 *
 * Post-Phase 26 / 26b: `site` (read) + `cache` (compile cache) are the
 * canonical capabilities.
 */
export interface Host {
	/** Read-only file capability the framework consumes. */
	site: Site;
	/** Content-addressed compile cache. */
	cache: Cache;
	executor: Executor;
	coordinator: Coordinator;
	transport: Transport;
	clock: Clock;
	logger: Logger;
	/**
	 * Optional asset pipeline (Phase 13). When absent, image imports
	 * fall back to a degraded path (the import is left in the bundle
	 * and the runtime `<Image>` component renders the bare path).
	 */
	imageService?: ImageService;
	/**
	 * Phase 15b RPC services. Optional — when absent, the framework
	 * uses degraded in-process defaults. Hosts that supply them wire
	 * Cloudflare-bound implementations (Cloudflare Images for
	 * `imageService`, the host worker's env binding for `envService`,
	 * the `Logger` for `logService`, the host's filesystem capability
	 * for `fsService`).
	 */
	fsService?: FsService;
	logService?: LogService;
	envService?: EnvService;
}

/**
 * Workspace-write RPC (§9.3 of the brief). External agents
 * (LSP / IDE plugin / dev server) call `FsService.write(path, bytes)`
 * to add or update a file; the implementation persists to the host's
 * filesystem and notifies the framework so HMR fans out to connected
 * previews.
 *
 * Phase 15b ships the interface plus an in-process default
 * (`InMemoryFsService` from `@astroflare/test-utils`); a real
 * Cap'n Web RPC class lands when the agent surface gets fleshed
 * out.
 */
export interface FsService {
	write(path: string, bytes: Uint8Array): Promise<void>;
	read(path: string): Promise<Uint8Array | null>;
	remove(path: string): Promise<void>;
	stat(path: string): Promise<FsStat | null>;
}

export interface FsStat {
	size: number;
	hash: string;
	/**
	 * Last-modified timestamp in ms-since-epoch, when the underlying
	 * filesystem exposes one. `Site.statFile` doesn't yet carry mtime;
	 * in-memory implementations use `0`. Wire from the Cloudflare R2
	 * binding's `uploaded` field when the host implementation gets
	 * there.
	 */
	mtime?: number;
}

/**
 * Structured logging RPC. Workers running inside a spawned isolate
 * call `LogService.event(...)` to surface events into the parent
 * worker's logger. Same shape as `Logger.event` so the parent's
 * implementation can serve both sides.
 */
export interface LogService {
	event(name: string, fields: Record<string, unknown>): Promise<void>;
}

/**
 * Per-request env / secret RPC. Spawned isolates can't read the
 * parent's `process.env` (each isolate has its own scope); the
 * service shovels secrets across the boundary on demand.
 *
 * Phase 15b ships the interface; cross-isolate threading of
 * `getSecret(name)` from inside user code is Phase 15c — until
 * then the service is a parent-worker affordance, not yet wired
 * into the spawned isolate's runtime.
 */
export interface EnvService {
	getSecret(name: string): Promise<string | undefined>;
	listSecretNames(): Promise<readonly string[]>;
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
	 * Handle a WebSocket upgrade for HMR. Async because DO-routed transports
	 * round-trip into a Durable Object before returning the upgrade response.
	 */
	handleHmrUpgrade(req: Request): Promise<Response>;

	/**
	 * Notify the framework that a file changed. The agent's `FsService.write`
	 * RPC calls this synchronously after the workspace write succeeds (§5.4).
	 * Implementations propagate to the coordinator and trigger HMR fan-out.
	 */
	notifyFileChanged(path: string, hash: string): Promise<void>;

	/**
	 * Notify the framework that a file was removed. Symmetric with
	 * `notifyFileChanged`; produces an HMR `prune` rather than `update`.
	 */
	notifyFileRemoved(path: string): Promise<void>;
}

// -----------------------------------------------------------------------------
// AstroGlobal — the user-visible `Astro.*` API surface (Tier 0)
// -----------------------------------------------------------------------------

/**
 * The `Astro` object available to every `.astro` component's frontmatter and
 * template. Tier 0 surface (per §3 of the brief). Phase 10 closes out the
 * carry-overs from Phase 3: cookies, locals, slots, redirect propagation.
 *
 * `Astro.self` (recursive components) remains deferred — it's listed as a
 * Tier 0 niche feature in the brief but `docs/next-phases.md` carves it
 * out explicitly.
 */
export interface AstroGlobal<P = Record<string, unknown>, L = Record<string, unknown>> {
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
	/**
	 * Per-request cookie helper. Reads parse `Cookie` header lazily; writes
	 * accumulate `Set-Cookie` headers that the framework merges into the
	 * outgoing response.
	 */
	cookies: AstroCookies;
	/**
	 * Per-request scratch bag set by middleware and read by pages. Astro
	 * exposes a typed `App.Locals` declaration; we use a generic for now.
	 */
	locals: L;
	/** Imperative slot rendering API (frontmatter-side). */
	slots: AstroSlots;
	/**
	 * Locale resolved for this request from the project's i18n config
	 * (Phase 18). `undefined` when no `i18n` config is set.
	 */
	currentLocale?: string;
	/**
	 * Best `Accept-Language` match among `i18n.locales`. `undefined`
	 * when no header is sent or no locales match.
	 */
	preferredLocale?: string;
	/**
	 * Full ordered list of project-supported locales from
	 * `Accept-Language`, sorted by client preference.
	 */
	preferredLocaleList?: readonly string[];
	/**
	 * Astro-parity recursive-render handle (Phase 10 deferred follow-up).
	 * Lets a component invoke itself: `<Astro.self items={children} />`.
	 * `undefined` for top-level route renders.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: erased component reference
	self?: any;
}

/**
 * Cookie helper — Astro-shaped surface (`get`, `set`, `delete`, `has`).
 * Implementations parse `Cookie` lazily on first read and stage writes
 * (a list of `Set-Cookie` strings) until the framework calls `headers()`
 * to merge them into the outgoing response.
 */
export interface AstroCookies {
	get(name: string): AstroCookieValue | undefined;
	has(name: string): boolean;
	set(name: string, value: string, options?: AstroCookieSetOptions): void;
	delete(name: string, options?: AstroCookieSetOptions): void;
	/**
	 * Snapshot of `Set-Cookie` headers staged by `set`/`delete` calls so far.
	 * Each entry is a single `Set-Cookie` value (no `Set-Cookie: ` prefix).
	 */
	headers(): readonly string[];
}

export interface AstroCookieValue {
	/** Raw decoded value. */
	value: string;
	/** Same as `value`, retained as `.json()` for parity with Astro's API. */
	json(): unknown;
	/** Same as `value`, parity with Astro. */
	number(): number;
	boolean(): boolean;
}

export interface AstroCookieSetOptions {
	domain?: string;
	expires?: Date;
	httpOnly?: boolean;
	maxAge?: number;
	path?: string;
	sameSite?: "strict" | "lax" | "none" | boolean;
	secure?: boolean;
}

/**
 * Imperative slot API. The compiler maps frontmatter `Astro.slots.has(name)`
 * to a lookup against the slot map passed in by the caller; `render(name)`
 * runs the slot's render function and returns raw HTML.
 */
export interface AstroSlots {
	has(name: string): boolean;
	render(name: string, args?: readonly unknown[]): Promise<string>;
}

/**
 * Context the framework supplies to `render()` to build the AstroGlobal.
 */
export interface RenderContext<P = Record<string, unknown>, L = Record<string, unknown>> {
	props: P;
	params: Record<string, string>;
	request: Request;
	url: URL;
	site?: string;
	/** Optional locals bag (set by middleware, read by pages). Defaults to `{}`. */
	locals?: L;
	/**
	 * Resolved request locale (Phase 18). Set by the router when an
	 * `i18n` config is present; surfaced as `Astro.currentLocale`.
	 */
	currentLocale?: string;
	/** Best Accept-Language match — surfaced as `Astro.preferredLocale`. */
	preferredLocale?: string;
	/** Full Accept-Language preference list — `Astro.preferredLocaleList`. */
	preferredLocaleList?: readonly string[];
}

/**
 * What a render returns. JSON-serialisable so it crosses the executor's
 * fetch-shaped RPC boundary intact.
 *
 *   - `kind: "html"` — the route rendered HTML normally; `cookies` is the
 *     list of staged `Set-Cookie` strings (callers merge into the final
 *     `Response`).
 *   - `kind: "response"` — the route returned a `Response` (typically
 *     `Astro.redirect(...)`). `status`, `headers`, and `body` reconstruct
 *     it on the parent side; `cookies` rides along.
 */
export type RenderResult =
	| { kind: "html"; html: string; cookies: readonly string[] }
	| {
			kind: "response";
			status: number;
			headers: Readonly<Record<string, string>>;
			body: string | null;
			cookies: readonly string[];
	  };

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
	/**
	 * Compile-time `import.meta.env` substitutions. Each key becomes
	 * accessible as `import.meta.env.<KEY>`; the compiler replaces the
	 * access with the JSON-stringified value. Use this for build-time
	 * configuration; runtime secrets land in Phase 15's `EnvService`.
	 */
	env?: Record<string, unknown>;
	/**
	 * Internationalisation routing (Phase 18). Optional; when present,
	 * the router resolves `Astro.currentLocale` from the URL prefix and
	 * `getRelativeLocaleUrl` produces locale-prefixed links.
	 */
	i18n?: I18nConfig;
	/** Vite is forbidden (§10) — kept here only so we can throw a clear error
	 *  if someone copies an Astro config that includes it. */
	vite?: never;
}

/**
 * Astroflare i18n configuration (Phase 18). Astro-shaped subset:
 * `locales` is the supported set, `defaultLocale` is the fallback when
 * the URL has no recognised prefix, and `routing` controls whether the
 * default locale is rendered at the root path or with its own prefix.
 *
 * Example:
 * ```ts
 * defineConfig({
 *   i18n: {
 *     locales: ["en", "fr", "de"],
 *     defaultLocale: "en",
 *     routing: "pathname-prefix-other", // /, /fr/, /de/
 *   },
 * });
 * ```
 *
 * `prefix-default` adds the default locale to the URL too (`/en/`,
 * `/fr/`, `/de/`); `pathname-prefix-other` (Astro's default) keeps the
 * default locale at the root.
 */
export interface I18nConfig {
	locales: readonly string[];
	defaultLocale: string;
	/** Default: `"pathname-prefix-other"`. */
	routing?: "prefix-default" | "pathname-prefix-other";
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
