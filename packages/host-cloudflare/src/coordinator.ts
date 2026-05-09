/**
 * `createCoordinator` — in-DO factory replacing `CoordinatorDurableObject`
 * + `DurableObjectCoordinator` + `HibernatingHmrTransport` (Phase 26).
 *
 * Returns a coordinator object the host calls inside its own
 * SiteDurableObject. Owns the module graph (in DO sqlite under `aflare_*`
 * table prefix), the change pipeline, and HMR WebSocket fanout (using the
 * host's DO `ctx` for hibernation-aware socket lifecycle).
 *
 * No DO classes ship from `@astroflare/host-cloudflare`. The host's DO
 * extends `DurableObject` directly, instantiates a coordinator in its
 * constructor, and delegates `webSocketMessage` / `webSocketClose` to it.
 *
 * ## Module graph schema (`aflare_*`)
 *
 *   aflare_module_graph (path PK, hash, imports_json)
 *   aflare_module_imported_by (path, importer, PK(path, importer))
 *
 * Reverse edges are maintained in step with `imports` writes so transitive
 * walks are linear in closure size, not depth. The whole pipeline runs
 * synchronously inside the DO — no cross-stub round-trips.
 *
 * ## HMR fanout
 *
 * Browsers connect to the host's DO via `acceptHmrSocket(req)`. The
 * coordinator calls `ctx.acceptWebSocket(server, ["aflare-hmr"])` (the
 * Hibernatable WS API) so subscriptions survive DO eviction. Broadcast
 * iterates `ctx.getWebSockets("aflare-hmr")` — fan-out is local (single DO
 * per site), so no transport-DO round-trip is needed.
 *
 * ## In-process pubsub
 *
 * `publish` / `subscribe` keep an in-isolate JS-callback registry alongside
 * the WS broadcast. Used by preview-server for module-graph fanout (e.g.
 * "this file changed, invalidate caches in this isolate"). Lost on
 * hibernation — re-subscribed on wake.
 */

import { isCompileError } from "@astroflare/compiler";
import type {
	HmrError,
	HmrMessage,
	HmrUpdate,
	ModuleNode,
	Site,
	SiteChangeEvent,
	SnapshotErrorDiagnostic,
	Subscription,
} from "@astroflare/core";
import { buildCodeFrame, snippetFor } from "@astroflare/core";
import type { SqlBackend } from "./sql-cache.js";

/**
 * Optional compile pre-flight hook for {@link AstroflareCoordinator.notifyChanged}.
 * Receives the workspace path of the changed file and resolves on a
 * clean compile; rejects with a `CompileError` (or any other `Error`)
 * when the new bytes don't compile.
 *
 * The framework's `ModuleGraph.compile(path)` satisfies this signature
 * directly — hosts pass `compile: (p) => moduleGraph.compile(p).then(() => {})`
 * to wire the framework's own compiler in. Tests can supply a stub.
 */
export type CompilePreflight = (path: string) => Promise<unknown>;

/**
 * Subset of `DurableObjectState` we use. Letting the host pass any compatible
 * shape keeps the factory testable without `cloudflare:workers`.
 */
export interface CoordinatorContext {
	acceptWebSocket(ws: WebSocket, tags?: string[]): void;
	getWebSockets(tag?: string): WebSocket[];
}

const HMR_TAG = "aflare-hmr";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS aflare_module_graph (
	path TEXT PRIMARY KEY,
	hash TEXT NOT NULL,
	imports_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS aflare_module_imported_by (
	path TEXT NOT NULL,
	importer TEXT NOT NULL,
	PRIMARY KEY (path, importer)
);
CREATE INDEX IF NOT EXISTS aflare_module_imported_by_path ON aflare_module_imported_by (path);
CREATE INDEX IF NOT EXISTS aflare_module_imported_by_importer ON aflare_module_imported_by (importer);
`;

export interface CreateCoordinatorOptions {
	/** DO sqlite (typically `ctx.storage.sql`). */
	sql: SqlBackend;
	/**
	 * The host's `Site` capability. Used by `notifyChanged` if the change
	 * event needs rehashing, and exposed so callers can read alongside the
	 * coordinator's graph state.
	 */
	site?: Site;
	/**
	 * The host's DO state. Required if you want the coordinator to handle
	 * HMR WebSocket lifecycle (`acceptHmrSocket` / `webSocketMessage` /
	 * `webSocketClose`). Optional otherwise — for unit tests that exercise
	 * graph operations without sockets.
	 */
	ctx?: CoordinatorContext;
	/**
	 * Optional compile pre-flight. When supplied, callers may pass
	 * `{ verifyCompile: true }` to {@link AstroflareCoordinator.notifyChanged}
	 * for the coordinator to drive the compile *before* deciding what
	 * to publish — clean compiles fall through to the existing HMR
	 * `update` path; failures publish an HMR `error` carrying the
	 * structured diagnostics. Lets every embedder pull the
	 * "stop-stranding-the-iframe" guarantee in for free instead of
	 * shipping a host-side substitute.
	 *
	 * The framework's `ModuleGraph.compile(path)` is the canonical
	 * supplier — wire it as
	 * `compile: (p) => moduleGraph.compile(p).then(() => {})`.
	 */
	compile?: CompilePreflight;
}

/**
 * Recently-published HMR event, oldest → newest. Returned by
 * {@link AstroflareCoordinator.recentHmrEvents}. Best-effort across
 * DO eviction — the buffer lives in in-isolate JS state and resets
 * on hibernation.
 */
export interface HmrEventRecord {
	/** Wall-clock timestamp (`Date.now()`) when the event was published. */
	at: number;
	/** The exact `HmrMessage` that was broadcast on the `"hmr"` channel. */
	message: HmrMessage;
}

/** Default cap for the recent-HMR-events ring buffer. */
const HMR_RING_CAP = 32;

/**
 * Per-call options for {@link AstroflareCoordinator.notifyChanged}.
 *
 * When `verifyCompile` is `true` and the coordinator was constructed with
 * a `compile` pre-flight (see {@link CreateCoordinatorOptions.compile}),
 * the coordinator drives the compile against the changed file *before*
 * deciding which HMR message to publish. Clean compiles flow through the
 * existing reverse-edge `update` walk; `CompileError`s (or any other
 * pre-flight throw) publish an HMR `error` carrying structured
 * diagnostics so the iframe overlay can render the failure on top of the
 * previous good page.
 *
 * Strictly opt-in. Callers that don't pass it (existing embedders) get
 * the historical behaviour. Without a `compile` hook the flag is a
 * no-op so a host can flip it on speculatively without crashing.
 */
export interface NotifyChangedOptions {
	verifyCompile?: boolean;
}

export interface AstroflareCoordinator {
	// Change pipeline
	notifyChanged(event: SiteChangeEvent, opts?: NotifyChangedOptions): Promise<void>;
	notifyRemoved(path: string): Promise<void>;

	// Module graph
	graphGet(path: string): Promise<ModuleNode | null>;
	graphPut(node: ModuleNode): Promise<void>;
	graphRemove(path: string): Promise<void>;
	transitiveImporters(path: string): Promise<readonly string[]>;
	graphList(): Promise<readonly ModuleNode[]>;

	// In-process pubsub (per-isolate JS callbacks)
	publish(channel: string, message: HmrMessage): Promise<void>;
	subscribe(channel: string, handler: (m: HmrMessage) => void): Subscription;

	// HMR WebSocket lifecycle — host's DO delegates here.
	acceptHmrSocket(req: Request): Response;
	webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): void;
	webSocketClose(ws: WebSocket, code: number): void;

	// Diagnostic helper: number of currently-attached HMR sockets.
	hmrConnectionCount(): number;

	/**
	 * Recently-published HMR messages, oldest → newest. Capped to
	 * `limit` (default 32). Lets operator-side health checks verify
	 * the change pipeline is firing without spinning up a browser.
	 *
	 * Best-effort across DO eviction — the underlying buffer is in-
	 * isolate JS state, lost on hibernation. Returns `[]` if no HMR
	 * events have been published since the isolate started.
	 */
	recentHmrEvents(limit?: number): readonly HmrEventRecord[];

	/**
	 * Test helper: synthesize a {@link SiteChangeEvent} and drive it
	 * through {@link notifyChanged} without going through
	 * `Workspace.onChange`. Equivalent to calling `notifyChanged`
	 * directly — exists as a named entry point so test setup reads
	 * intent-first ("simulate a change to /x.astro") instead of
	 * mechanism-first ("call the change pipeline with this event").
	 */
	simulateChange(event: SiteChangeEvent): Promise<void>;
}

/** Workspace extensions the optional compile pre-flight runs against. */
const COMPILABLE_EXTENSIONS = [".astro", ".md", ".mdx"] as const;

export function createCoordinator(opts: CreateCoordinatorOptions): AstroflareCoordinator {
	const sql = opts.sql;
	const ctx = opts.ctx;
	const compilePreflight = opts.compile;
	let initialized = false;
	const subs = new Map<string, Set<(m: HmrMessage) => void>>();
	// Ring buffer of recent HMR events. In-isolate state — resets on
	// DO eviction. Capped to `HMR_RING_CAP`; index points at the next
	// write slot.
	const hmrRing: (HmrEventRecord | undefined)[] = new Array(HMR_RING_CAP);
	let hmrRingNext = 0;
	let hmrRingCount = 0;

	function ensure(): void {
		if (initialized) return;
		// `exec` accepts multi-statement strings.
		sql.exec(SCHEMA);
		initialized = true;
	}

	async function graphGet(path: string): Promise<ModuleNode | null> {
		ensure();
		const rows = sql
			.exec<{ path: string; hash: string; imports_json: string }>(
				"SELECT path, hash, imports_json FROM aflare_module_graph WHERE path = ?",
				path,
			)
			.toArray();
		const first = rows[0];
		if (!first) return null;
		const importedByRows = sql
			.exec<{ importer: string }>(
				"SELECT importer FROM aflare_module_imported_by WHERE path = ?",
				path,
			)
			.toArray();
		return {
			path: first.path,
			hash: first.hash,
			imports: JSON.parse(first.imports_json) as string[],
			importedBy: importedByRows.map((r) => r.importer),
		};
	}

	async function graphPut(node: ModuleNode): Promise<void> {
		ensure();
		const prev = await graphGet(node.path);
		const oldImports = new Set(prev?.imports ?? []);
		const newImports = new Set(node.imports);

		// Reverse-edge bookkeeping.
		for (const target of oldImports) {
			if (!newImports.has(target)) {
				sql.exec(
					"DELETE FROM aflare_module_imported_by WHERE path = ? AND importer = ?",
					target,
					node.path,
				);
			}
		}
		for (const target of newImports) {
			if (!oldImports.has(target)) {
				sql.exec(
					"INSERT OR IGNORE INTO aflare_module_imported_by (path, importer) VALUES (?, ?)",
					target,
					node.path,
				);
			}
		}

		sql.exec(
			"INSERT OR REPLACE INTO aflare_module_graph (path, hash, imports_json) VALUES (?, ?, ?)",
			node.path,
			node.hash,
			JSON.stringify(node.imports),
		);
	}

	async function graphRemove(path: string): Promise<void> {
		ensure();
		const node = await graphGet(path);
		if (!node) return;
		// Clear our outbound reverse edges.
		for (const target of node.imports) {
			sql.exec(
				"DELETE FROM aflare_module_imported_by WHERE path = ? AND importer = ?",
				target,
				path,
			);
		}
		// Clear inbound — anyone who imported us has a broken ref now.
		for (const importer of node.importedBy) {
			const imp = await graphGet(importer);
			if (!imp) continue;
			const remaining = imp.imports.filter((p) => p !== path);
			sql.exec(
				"UPDATE aflare_module_graph SET imports_json = ? WHERE path = ?",
				JSON.stringify(remaining),
				importer,
			);
		}
		sql.exec("DELETE FROM aflare_module_imported_by WHERE path = ?", path);
		sql.exec("DELETE FROM aflare_module_graph WHERE path = ?", path);
	}

	async function transitiveImporters(path: string): Promise<readonly string[]> {
		ensure();
		const seen = new Set<string>();
		const queue: string[] = [path];
		while (queue.length > 0) {
			const cur = queue.shift() as string;
			const rows = sql
				.exec<{ importer: string }>(
					"SELECT importer FROM aflare_module_imported_by WHERE path = ?",
					cur,
				)
				.toArray();
			for (const r of rows) {
				if (!seen.has(r.importer)) {
					seen.add(r.importer);
					queue.push(r.importer);
				}
			}
		}
		return Array.from(seen);
	}

	async function graphList(): Promise<readonly ModuleNode[]> {
		ensure();
		const rows = sql
			.exec<{ path: string; hash: string; imports_json: string }>(
				"SELECT path, hash, imports_json FROM aflare_module_graph ORDER BY path",
			)
			.toArray();
		const out: ModuleNode[] = [];
		for (const row of rows) {
			const importedByRows = sql
				.exec<{ importer: string }>(
					"SELECT importer FROM aflare_module_imported_by WHERE path = ?",
					row.path,
				)
				.toArray();
			out.push({
				path: row.path,
				hash: row.hash,
				imports: JSON.parse(row.imports_json) as string[],
				importedBy: importedByRows.map((r) => r.importer),
			});
		}
		return out;
	}

	async function publish(channel: string, message: HmrMessage): Promise<void> {
		// In-process callbacks first.
		const handlers = subs.get(channel);
		if (handlers) {
			for (const h of Array.from(handlers)) {
				try {
					h(message);
				} catch {
					// Subscribers must not throw upstream; swallow.
				}
			}
		}
		// Fan out HMR messages to attached browser sockets and stash
		// the event in the diagnostic ring so operator tools can
		// verify the pipeline fired.
		if (channel === "hmr") {
			recordHmrEvent(message);
			if (ctx) broadcastHmrToSockets(message);
		}
	}

	function recordHmrEvent(message: HmrMessage): void {
		hmrRing[hmrRingNext] = { at: Date.now(), message };
		hmrRingNext = (hmrRingNext + 1) % HMR_RING_CAP;
		if (hmrRingCount < HMR_RING_CAP) hmrRingCount++;
	}

	function recentHmrEvents(limit?: number): readonly HmrEventRecord[] {
		const cap = limit === undefined ? hmrRingCount : Math.max(0, Math.min(limit, hmrRingCount));
		if (cap === 0) return [];
		// Walk oldest → newest. Oldest sits `hmrRingCount` slots
		// behind `hmrRingNext` once the buffer wraps; before that,
		// it's at index 0.
		const start = (hmrRingNext - hmrRingCount + HMR_RING_CAP) % HMR_RING_CAP;
		const out: HmrEventRecord[] = [];
		const skip = hmrRingCount - cap;
		for (let i = 0; i < hmrRingCount; i++) {
			if (i < skip) continue;
			const slot = hmrRing[(start + i) % HMR_RING_CAP];
			if (slot) out.push(slot);
		}
		return out;
	}

	function subscribe(channel: string, handler: (m: HmrMessage) => void): Subscription {
		let set = subs.get(channel);
		if (!set) {
			set = new Set();
			subs.set(channel, set);
		}
		set.add(handler);
		return {
			unsubscribe: () => {
				set?.delete(handler);
				if (set && set.size === 0) subs.delete(channel);
			},
		};
	}

	function broadcastHmrToSockets(msg: HmrMessage): void {
		if (!ctx) return;
		const payload = JSON.stringify(msg);
		const sockets = ctx.getWebSockets(HMR_TAG);
		for (const ws of sockets) {
			try {
				ws.send(payload);
			} catch {
				// Socket may have closed mid-iteration; the Hibernation API is
				// resilient — drop quietly.
			}
		}
	}

	async function notifyChanged(
		event: SiteChangeEvent,
		notifyOpts?: NotifyChangedOptions,
	): Promise<void> {
		if (event.kind === "delete") {
			return notifyRemoved(event.path);
		}
		const { path, hash } = event;
		const existing = await graphGet(path);
		if (existing) {
			await graphPut({ ...existing, hash });
		} else {
			await graphPut({ path, hash, imports: [], importedBy: [] });
		}

		// Optional compile pre-flight: if the host wired one in (and
		// the change touches a compilable file), run it before
		// deciding what to publish. A clean compile falls through to
		// the historical update; a `CompileError` swaps the broadcast
		// for an HMR `error` so the iframe overlay can surface the
		// failure on top of the previous good render.
		if (notifyOpts?.verifyCompile === true && compilePreflight && isCompilablePath(path)) {
			try {
				await compilePreflight(path);
			} catch (err) {
				const errorMessage: HmrError = projectCompileError(path, err);
				await publish("hmr", { type: "error", error: errorMessage });
				return;
			}
		}

		const importers = await transitiveImporters(path);
		const updates: HmrUpdate[] = [path, ...importers].map((p) => ({
			path: p,
			hash: p === path ? hash : "",
			kind: p.endsWith(".css") ? "css" : "module",
		}));
		await publish("hmr", { type: "update", trigger: path, updates });
	}

	async function notifyRemoved(path: string): Promise<void> {
		const importers = await transitiveImporters(path);
		await graphRemove(path);
		await publish("hmr", { type: "prune", paths: [path, ...importers] });
	}

	function acceptHmrSocket(_req: Request): Response {
		if (!ctx) {
			throw new Error(
				"createCoordinator: ctx is required for acceptHmrSocket — pass the host DO state",
			);
		}
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		ctx.acceptWebSocket(server, [HMR_TAG]);
		return new Response(null, { status: 101, webSocket: client });
	}

	function webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): void {
		// Client → server messages aren't part of the HMR protocol (server
		// pushes only). If a future feature needs them, decode here.
	}

	function webSocketClose(_ws: WebSocket, _code: number): void {
		// Cloudflare auto-removes closed sockets from `getWebSockets()`; no
		// manual bookkeeping needed.
	}

	function hmrConnectionCount(): number {
		if (!ctx) return 0;
		return ctx.getWebSockets(HMR_TAG).length;
	}

	async function simulateChange(
		event: SiteChangeEvent,
		notifyOpts?: NotifyChangedOptions,
	): Promise<void> {
		await notifyChanged(event, notifyOpts);
	}

	return {
		notifyChanged,
		notifyRemoved,
		graphGet,
		graphPut,
		graphRemove,
		transitiveImporters,
		graphList,
		publish,
		subscribe,
		acceptHmrSocket,
		webSocketMessage,
		webSocketClose,
		hmrConnectionCount,
		recentHmrEvents,
		simulateChange,
	};
}

function isCompilablePath(path: string): boolean {
	for (const ext of COMPILABLE_EXTENSIONS) {
		if (path.endsWith(ext)) return true;
	}
	return false;
}

/**
 * Project a pre-flight error onto an `HmrError`. `CompileError` payloads
 * fan out into the structured `diagnostics` / `codeFrame` / `snippet`
 * fields the dev overlay knows how to render; everything else lands as
 * a bare message + stack so the iframe still surfaces _something_.
 *
 * Mirrors `buildError()` in `@astroflare/build` (PR #15) so a
 * `CompileError` looks identical whether it came from `buildSite`'s
 * snapshot pipeline or the live preview's pre-flight.
 */
function projectCompileError(path: string, err: unknown): HmrError {
	if (isCompileError(err)) {
		const source = err.source;
		const diagnostics: SnapshotErrorDiagnostic[] = err.diagnostics.map((d) => {
			const location = {
				line: d.start.line,
				column: d.start.column,
				offset: d.start.offset,
				...(d.end ? { end: { line: d.end.line, column: d.end.column, offset: d.end.offset } } : {}),
			};
			const diag: SnapshotErrorDiagnostic = { message: d.message, location };
			const snippet = snippetFor(source, location);
			if (snippet) diag.snippet = snippet;
			const frame = buildCodeFrame(source, location);
			if (frame) diag.codeFrame = frame;
			return diag;
		});
		const primary = diagnostics[0];
		const out: HmrError = {
			message: primary?.message ?? err.message,
			path,
		};
		if (primary?.location) {
			out.line = primary.location.line;
			out.column = primary.location.column;
		}
		if (primary?.snippet) out.snippet = primary.snippet;
		if (primary?.codeFrame) out.codeFrame = primary.codeFrame;
		if (diagnostics.length > 0) out.diagnostics = diagnostics;
		return out;
	}
	const message = (err as Error)?.message ?? String(err);
	const out: HmrError = { message, path };
	const stack = (err as { stack?: unknown })?.stack;
	if (typeof stack === "string" && stack.length > 0) out.stack = stack;
	return out;
}
