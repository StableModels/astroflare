/**
 * `WorkerdExecutor` — production-shaped `Executor` backed by Cloudflare's
 * Worker Loader binding. The brief's §4 calls this out as the load-bearing
 * primitive: V8 isolates, ms startup, MB memory, content-addressed cache.
 *
 * Per §5.2 the framework receives the executor through the `Executor`
 * interface only; this implementation is the only place that touches the
 * `WorkerLoader` binding directly.
 *
 * ## API surface contract
 *
 * The brief's §4 lists `loader.load(code)` and `loader.get(id, codeFactory)`.
 * Workerd 2025 ships only `get(name, factory)` — `name: null` is the
 * "no-cache, fresh isolate every call" form (which is what the brief
 * describes as `load`). We use `get` exclusively.
 *
 * ## Marshalling input / output
 *
 * The framework `Executor` interface promises `runOnce<R>(task, input: unknown)
 * → Promise<R>` — arbitrary JS in, arbitrary JS out. Worker Loader uses
 * fetch-shaped RPC (parent calls `stub.getEntrypoint().fetch(request)`,
 * child returns `Response`), so the executor wraps each `TaskBundle` with
 * a thin entrypoint that:
 *   - awaits the user's `mainModule.default(input)`
 *   - serialises the result to JSON in a `Response`
 *
 * Input is JSON-encoded into the request body. **JSON is the marshalling
 * floor** — `Request`, `Response`, `URL`, `Map`, `Set`, `Date`, functions,
 * Symbols don't survive. Callers passing a `RenderContext`-shaped value
 * (which contains a `Request`) need to flatten request shape into JSON-
 * friendly fields first; helpers for that live in `host-cloudflare`'s
 * preview integration (Phase 2.5d).
 *
 * ## §9.1 size threshold
 *
 * The brief warns: `WorkerCode.modules` payloads above ~256 KB count
 * against the parent Worker's memory. The executor accepts a `maxInlineBytes`
 * threshold; bundles above it should be fetched from `FsService.cacheRead`
 * inside the spawned isolate rather than inlined. Phase 2.5c implements
 * the threshold check (and logs when it would matter); the actual lazy-fetch
 * mode lands once the host's `FsService` exists.
 */

import type { Executor, TaskBundle } from "@astroflare/core";

const DEFAULT_COMPATIBILITY_DATE = "2025-09-01";
const DEFAULT_MAX_INLINE_BYTES = 256 * 1024;

const WRAPPER_NAME = "__aflare_wrapper.js";

export interface WorkerdExecutorOptions {
	/**
	 * The bound `WorkerLoader`. Tests get this from `env.LOADER` via
	 * vitest-pool-workers; production hosts get it via the Project Worker's
	 * `env`.
	 */
	loader: WorkerLoader;
	/**
	 * Compatibility date used for spawned child workers. Default
	 * `"2025-09-01"` — the date the Worker Loader binding stabilised.
	 */
	compatibilityDate?: string;
	/** Compatibility flags forwarded to spawned workers. */
	compatibilityFlags?: readonly string[];
	/**
	 * Soft cap on inlined bundle bytes per §9.1. Bundles larger than this
	 * still run, but the executor logs a warning the host can hook into to
	 * implement RPC-fetch fallback (Phase 2.5+). Default 256 KB.
	 */
	maxInlineBytes?: number;
	/** Optional logger for warnings (size threshold, slow spawns, etc.). */
	logger?: { event(name: string, fields: Record<string, unknown>): void };
}

interface InvocationResult<R> {
	ok: boolean;
	result?: R;
	error?: { message: string; stack?: string };
}

export class WorkerdExecutor implements Executor {
	readonly #loader: WorkerLoader;
	readonly #compatibilityDate: string;
	readonly #compatibilityFlags?: readonly string[];
	readonly #maxInlineBytes: number;
	readonly #logger: WorkerdExecutorOptions["logger"];

	constructor(opts: WorkerdExecutorOptions) {
		this.#loader = opts.loader;
		this.#compatibilityDate = opts.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE;
		this.#compatibilityFlags = opts.compatibilityFlags;
		this.#maxInlineBytes = opts.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
		this.#logger = opts.logger;
	}

	async runOnce<R>(task: TaskBundle, input: unknown): Promise<R> {
		// `name: null` means "no cache, fresh isolate every call" — the brief's
		// `load(code)` form.
		const stub = this.#loader.get(null, () => this.#toWorkerCode(task));
		return this.#invoke<R>(stub, input);
	}

	async runCached<R>(id: string, taskFactory: () => TaskBundle, input: unknown): Promise<R> {
		const stub = this.#loader.get(id, () => this.#toWorkerCode(taskFactory()));
		return this.#invoke<R>(stub, input);
	}

	async #invoke<R>(stub: WorkerStub, input: unknown): Promise<R> {
		const ep = stub.getEntrypoint();
		const response = await ep.fetch("https://aflare-internal/invoke", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input }),
		});
		const payload = (await response.json()) as InvocationResult<R>;
		if (!payload.ok) {
			const err = new Error(payload.error?.message ?? "worker invocation failed");
			if (payload.error?.stack) err.stack = payload.error.stack;
			throw err;
		}
		return payload.result as R;
	}

	#toWorkerCode(task: TaskBundle): WorkerLoaderWorkerCode {
		const totalBytes = totalSize(task.modules);
		if (totalBytes > this.#maxInlineBytes) {
			this.#logger?.event("workerd-executor.large-bundle", {
				mainModule: task.mainModule,
				bytes: totalBytes,
				threshold: this.#maxInlineBytes,
			});
		}

		// Wrapper module: imports the user's main, exposes a fetch handler
		// that JSON-marshals the call. Child code never sees the parent's
		// fetch URL — the request body is the only payload that matters.
		const wrapper = `
import userMain from ${JSON.stringify(`./${task.mainModule}`)};
export default {
	async fetch(request) {
		try {
			const { input } = await request.json();
			const result = await userMain(input);
			return new Response(JSON.stringify({ ok: true, result }), {
				headers: { "content-type": "application/json" },
			});
		} catch (err) {
			return new Response(JSON.stringify({
				ok: false,
				error: { message: String(err && err.message || err), stack: err && err.stack },
			}), { status: 500, headers: { "content-type": "application/json" } });
		}
	},
};
`;
		return {
			compatibilityDate: this.#compatibilityDate,
			...(this.#compatibilityFlags ? { compatibilityFlags: [...this.#compatibilityFlags] } : {}),
			mainModule: WRAPPER_NAME,
			modules: {
				...task.modules,
				[WRAPPER_NAME]: wrapper,
			},
		};
	}
}

function totalSize(modules: Record<string, string>): number {
	let total = 0;
	for (const src of Object.values(modules)) total += src.length;
	return total;
}
