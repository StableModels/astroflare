/**
 * `project-worker.ts` — the production fetch entrypoint.
 *
 * Wires every framework primitive backed by Cloudflare:
 *
 *   - `Storage`     → `R2Storage` over an R2 bucket binding
 *   - `Coordinator` → `DurableObjectCoordinator` over a per-workspace DO
 *   - `Transport`   → `HibernatingHmrTransport` over the HMR DO namespace
 *   - `Executor`    → `WorkerdExecutor` over the Worker Loader binding,
 *                     wrapped in `RuntimeBundledExecutor` so every
 *                     spawned isolate carries the framework runtime
 *                     as inlined source
 *   - `clock`       → `Date.now()` shim
 *   - `logger`      → JSON-line console output (Workers logs / Logpush)
 *
 * Then routes the request through `@astroflare/preview`'s
 * `createPreviewServer`. The preview server in production isn't really
 * a "preview" — it's the live SSR pipeline. Naming is historical
 * (Phase 3); the deploy-time bundler (Phase 15a) eventually pre-bundles
 * routes for faster cold starts, but the preview server does the right
 * thing for warm requests today.
 *
 * ## The runtime-injection problem
 *
 * The framework's compiled bundles `import` from `runtimeImport` (e.g.
 * `@astroflare/runtime`). The Worker Loader-spawned child isolate
 * can't resolve npm packages — its module graph is exactly what we
 * hand it. So `runtimeImport` has to be a key in the spawned isolate's
 * own module map.
 *
 * `RuntimeBundledExecutor` solves this by prepending the framework
 * runtime files to every `TaskBundle.modules`. The default
 * `runtimeImport` is `./runtime/index.js`, which matches the
 * convention.
 *
 * The runtime modules themselves are supplied by the caller — the
 * test harness uses Vite's `?raw` imports of the runtime's dist
 * bundle; production deploys do the same at deploy time (Phase 15a).
 *
 * Re-exports `HmrDurableObject` and `CoordinatorDurableObject` so the
 * project's `wrangler.toml` can name them in `[[durable_objects]]`
 * blocks. Without these re-exports wrangler reports
 * "no class named X is exported by the script" at deploy time.
 */

import type {
	AstroflareConfig,
	Executor,
	Host,
	TaskBundle,
} from "@astroflare/core";
import { createPreviewServer } from "@astroflare/preview";
import { CoordinatorDurableObject, DurableObjectCoordinator } from "./coordinator-do.js";
import { WorkerdExecutor } from "./executor.js";
import { R2Storage } from "./r2-storage.js";
import { HibernatingHmrTransport, HmrDurableObject } from "./transport.js";

// Re-export the DO classes — wrangler needs to find them via the
// project worker's exports.
export { CoordinatorDurableObject, HmrDurableObject };

/**
 * Bindings the project worker expects in `env`. Hosts wire these in
 * `wrangler.toml`.
 */
export interface ProjectWorkerEnv {
	/** R2 bucket for the project workspace + compile cache. */
	FILES: R2Bucket;
	/** Coordinator DO namespace (one DO per workspace). */
	COORDINATOR_DO: DurableObjectNamespace<CoordinatorDurableObject>;
	/** HMR DO namespace (one DO per workspace). */
	HMR_DO: DurableObjectNamespace<HmrDurableObject>;
	/** Worker Loader binding, used by `WorkerdExecutor`. */
	LOADER: WorkerLoader;
}

export interface ProjectWorkerOptions {
	/**
	 * Per-tenant workspace identifier. Default `"default"`. Multi-tenant
	 * deployments derive this from a header, JWT, or the request URL
	 * before calling `createHost`.
	 */
	workspaceId?: string;
	/**
	 * Astroflare config — surface for `site`, `env`, etc. Most fields
	 * default to undefined.
	 */
	config?: AstroflareConfig;
	/**
	 * Module specifier compiled bundles import the framework runtime
	 * from. Default `./runtime/index.js`. Must be a key in
	 * `runtimeModules`.
	 */
	runtimeImport?: string;
	/**
	 * The framework runtime, supplied as a path → source map. Every
	 * spawned isolate (SSR bundle) gets these prepended to its module
	 * map. Pass an empty record at your peril — the SSR bundle's
	 * `import` of `runtimeImport` will fail at execution time.
	 */
	runtimeModules?: Record<string, string>;
}

const DEFAULT_WORKSPACE = "default";
const DEFAULT_RUNTIME_IMPORT = "./runtime/index.js";

/**
 * Build a fully-wired `Host` from the worker `env`.
 */
export function createHost(env: ProjectWorkerEnv, opts: ProjectWorkerOptions = {}): Host {
	const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE;
	const coordinatorStub = env.COORDINATOR_DO.get(env.COORDINATOR_DO.idFromName(workspaceId));
	const logger = makeLogger();
	// `nodejs_compat` is required so the framework runtime (which uses
	// `node:async_hooks` for per-request context) resolves inside the
	// child isolate. Compatibility date matches the parent worker's date
	// so spawned isolates see the same workerd behaviour.
	const baseExecutor = new WorkerdExecutor({
		loader: env.LOADER,
		logger,
		compatibilityDate: "2025-09-01",
		compatibilityFlags: ["nodejs_compat"],
	});
	const executor = opts.runtimeModules
		? new RuntimeBundledExecutor(baseExecutor, opts.runtimeModules)
		: baseExecutor;
	return {
		storage: new R2Storage({ bucket: env.FILES }),
		coordinator: new DurableObjectCoordinator(coordinatorStub),
		transport: new HibernatingHmrTransport(env.HMR_DO),
		executor,
		clock: { now: () => Date.now() },
		logger,
	};
}

/**
 * Build the project worker's fetch handler with explicit runtime
 * modules. Tests + production deploys use this rather than the bare
 * default export so they can plug in the framework runtime at the
 * right time (Vite's `?raw` for tests; Phase 15a's deploy bundler for
 * production).
 */
export function createFetchHandler(
	defaults: ProjectWorkerOptions = {},
): (req: Request, env: ProjectWorkerEnv, ctx: ExecutionContext) => Promise<Response> {
	const runtimeImport = defaults.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;
	return async (req: Request, env: ProjectWorkerEnv, _ctx: ExecutionContext) => {
		const host = createHost(env, defaults);
		const server = createPreviewServer({
			config: defaults.config ?? {},
			host,
			runtimeImport,
			workspaceId: defaults.workspaceId,
		});
		try {
			return await server.fetch(req);
		} finally {
			server.dispose();
		}
	};
}

/**
 * Default fetch handler. Convenience for the common case
 * (single-tenant, default workspace, runtime modules supplied via
 * `setProjectWorkerRuntime`). Hosts that need anything custom should
 * use `createFetchHandler` directly.
 */
let DEFAULT_RUNTIME_MODULES: Record<string, string> | null = null;

/**
 * Set the runtime modules used by the default fetch handler. Tests
 * and production deploy scripts call this once at module-load time,
 * before any request fires.
 */
export function setProjectWorkerRuntime(modules: Record<string, string>): void {
	DEFAULT_RUNTIME_MODULES = modules;
}

export default {
	async fetch(req: Request, env: ProjectWorkerEnv, ctx: ExecutionContext): Promise<Response> {
		if (!DEFAULT_RUNTIME_MODULES) {
			return new Response(
				"project-worker: runtime modules not configured. Call setProjectWorkerRuntime({…}) before serving.",
				{ status: 500, headers: { "content-type": "text/plain;charset=utf-8" } },
			);
		}
		return createFetchHandler({ runtimeModules: DEFAULT_RUNTIME_MODULES })(req, env, ctx);
	},
} satisfies ExportedHandler<ProjectWorkerEnv>;

/**
 * Wrap a base `Executor` so every spawned task carries an extra set of
 * modules — the framework runtime's compiled JS — alongside the user's
 * code. Without this, the SSR bundle's `import` of the runtime resolves
 * to nothing inside the child isolate.
 */
class RuntimeBundledExecutor implements Executor {
	readonly #base: Executor;
	readonly #runtime: Record<string, string>;

	constructor(base: Executor, runtimeModules: Record<string, string>) {
		this.#base = base;
		this.#runtime = runtimeModules;
	}

	async runOnce<R>(task: TaskBundle, input: unknown): Promise<R> {
		return this.#base.runOnce(this.#augment(task), input);
	}

	async runCached<R>(
		id: string,
		taskFactory: () => TaskBundle,
		input: unknown,
	): Promise<R> {
		return this.#base.runCached(id, () => this.#augment(taskFactory()), input);
	}

	#augment(task: TaskBundle): TaskBundle {
		// User modules win on collision so a project that ships its own
		// `runtime/index.js` (rare, but possible) isn't masked. In
		// practice the runtime/* keyspace is reserved by convention.
		return {
			...task,
			modules: { ...this.#runtime, ...task.modules },
		};
	}
}

/**
 * One-line JSON logger that flows into Workers logs (and Logpush, if
 * configured). Structured output is the cheapest format for downstream
 * log processing.
 */
function makeLogger() {
	return {
		event(name: string, fields: Record<string, unknown>) {
			console.log(JSON.stringify({ name, ...fields }));
		},
	};
}
