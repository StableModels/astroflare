/**
 * `preview-worker.ts` — in-Worker compile + render entrypoint
 * (Phase 25, Mode A of the dual-lifecycle proof). The production
 * deploy worker is `stack-worker.ts`.
 *
 * What it does on each request:
 *
 *   1. Maps the URL pathname to a workspace source path
 *      (`/<route>` → `/src/pages/<route>.astro`).
 *   2. Reads the source from R2 via `R2Storage`.
 *   3. Calls `compileAstro` with `skipTsTransform: true` so the
 *      parent bundle never loads esbuild-wasm. The compiled output
 *      imports the framework runtime symbols from
 *      `./runtime/index.js`.
 *   4. Spawns a fresh isolate via the Worker Loader binding,
 *      handing it: the compiled `.astro` module, a render shim,
 *      and the framework runtime files (inlined at build time).
 *      The shim calls `render(component, ctx)` and returns a
 *      JSON-serialisable `RenderResult`.
 *   5. Translates `kind: "html"` → 200 / text/html and
 *      `kind: "response"` → status + headers + body.
 *
 * Beyond fetch:
 *   - `POST /_aflare/file?path=<workspace-path>` writes a file to
 *     R2 (via `Storage.write`) then calls
 *     `Coordinator.onFileChanged(path, hash)` so the coordinator
 *     publishes an HMR `update` to subscribers.
 *   - `GET /_aflare/hmr` upgrades to a hibernating WebSocket via
 *     the HMR DO; messages survive isolate cycling.
 *   - `GET /_aflare/preview/info` returns diagnostic JSON.
 *
 * Bundle-size strategy: the heavy parts of the framework
 * (esbuild-wasm, MDX, react-dom/server) only run inside spawned
 * isolates, never in the parent worker. The parent's slim bundle
 * is what fits Cloudflare's free-plan 1 MiB cap; spawned isolates
 * inherit the parent's compatibility flags and run with their own
 * memory budget.
 */

import { compileAstro } from "@astroflare/compiler/astro";
import type { Executor, Host, TaskBundle } from "@astroflare/core";
import { CoordinatorDurableObject, DurableObjectCoordinator } from "./coordinator-do.js";
import { WorkerdExecutor } from "./executor.js";
import { R2Storage } from "./r2-storage.js";
import { HibernatingHmrTransport, HmrDurableObject } from "./transport.js";

export { CoordinatorDurableObject, HmrDurableObject };

/** Bindings the preview worker expects in `env`. */
export interface PreviewWorkerEnv {
	/** R2 bucket holding the workspace sources. */
	FILES: R2Bucket;
	/** Coordinator DO namespace (one DO per workspace). */
	COORDINATOR_DO: DurableObjectNamespace<CoordinatorDurableObject>;
	/** HMR DO namespace (one DO per workspace). */
	HMR_DO: DurableObjectNamespace<HmrDurableObject>;
	/** Worker Loader binding for spawning compile + render isolates. */
	LOADER: WorkerLoader;
	/** Bearer token gating the file-write + admin endpoints. */
	DEPLOY_TOKEN?: string;
}

/**
 * Pre-built runtime modules. The build script
 * (`scripts/build-preview-worker.mjs`) substitutes a JSON object
 * literal with keys like `runtime/index.js`, `runtime/internal.js`,
 * etc., each value being the runtime's compiled JS source. Spawned
 * isolates carry these alongside the user's compiled component, so
 * `import { render } from "./runtime/index.js"` resolves.
 */
declare const __AFLARE_RUNTIME_MODULES__: Record<string, string>;

const WORKSPACE_ID = "default";
const RUNTIME_IMPORT = "./runtime/index.js";

function makeHost(env: PreviewWorkerEnv): Host {
	const coordinatorStubFactory = () =>
		env.COORDINATOR_DO.get(env.COORDINATOR_DO.idFromName(WORKSPACE_ID));
	const logger = makeLogger();
	return {
		storage: new R2Storage({ bucket: env.FILES }),
		coordinator: new DurableObjectCoordinator(coordinatorStubFactory),
		transport: new HibernatingHmrTransport(env.HMR_DO),
		executor: makeRuntimeBundledExecutor(env),
		clock: { now: () => Date.now() },
		logger,
	};
}

function makeRuntimeBundledExecutor(env: PreviewWorkerEnv): Executor {
	const base = new WorkerdExecutor({
		loader: env.LOADER,
		compatibilityDate: "2025-09-01",
		compatibilityFlags: ["nodejs_compat"],
	});
	const runtimeModules: Record<string, string> =
		typeof __AFLARE_RUNTIME_MODULES__ !== "undefined" ? __AFLARE_RUNTIME_MODULES__ : {};
	return {
		async runOnce<R>(task: TaskBundle, input: unknown): Promise<R> {
			return base.runOnce(mergeRuntime(task, runtimeModules), input);
		},
		async runCached<R>(id: string, factory: () => TaskBundle, input: unknown): Promise<R> {
			return base.runCached(id, () => mergeRuntime(factory(), runtimeModules), input);
		},
	};
}

function mergeRuntime(task: TaskBundle, runtimeModules: Record<string, string>): TaskBundle {
	// User modules win on collision; runtime/* is reserved by convention.
	return {
		...task,
		modules: { ...runtimeModules, ...task.modules },
	};
}

function makeLogger() {
	return {
		event(name: string, fields: Record<string, unknown>): void {
			console.log(JSON.stringify({ ...fields, name }));
		},
	};
}

/**
 * Map a URL pathname like `/` or `/about` to the `.astro` workspace
 * path the preview worker will compile + render.
 */
function pathnameToSourcePath(pathname: string): string {
	const trimmed = pathname.replace(/\/+$/, "");
	const route = trimmed === "" ? "/index" : trimmed;
	return `/src/pages${route}.astro`;
}

const dec = new TextDecoder();

async function renderRoute(host: Host, sourcePath: string, request: Request): Promise<Response> {
	// `Storage.read` throws on miss per its contract; check existence
	// first via `stat` so missing routes 404 instead of 500.
	const stat = await host.storage.stat(sourcePath);
	if (!stat) {
		return new Response("Not found", {
			status: 404,
			headers: { "content-type": "text/plain;charset=utf-8" },
		});
	}
	const sourceBytes = await host.storage.read(sourcePath);
	const source = dec.decode(sourceBytes);
	let compiled: { code: string };
	try {
		compiled = await compileAstro(source, {
			filename: sourcePath,
			skipTsTransform: true,
			runtimeImport: RUNTIME_IMPORT,
		});
	} catch (err) {
		host.logger.event("preview.compile.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		return new Response(`compile failed: ${(err as Error).message}`, {
			status: 500,
			headers: { "content-type": "text/plain;charset=utf-8" },
		});
	}

	const url = new URL(request.url);
	// Render shim: imports the compiled component + the runtime,
	// calls `render(component, ctx)`, returns a JSON-serialisable
	// RenderResult that survives the Worker-Loader RPC boundary.
	const shim = [
		'import component from "./route.js";',
		`import { render } from ${JSON.stringify(RUNTIME_IMPORT)};`,
		"export default async (input) => {",
		'  const request = new Request(input.url, { method: input.method ?? "GET" });',
		"  const ctx = {",
		"    props: input.props ?? {},",
		"    params: input.params ?? {},",
		"    request,",
		"    url: new URL(input.url),",
		"    site: input.site,",
		"  };",
		"  return await render(component, ctx);",
		"};",
	].join("\n");

	const task: TaskBundle = {
		mainModule: "main.js",
		modules: {
			"main.js": shim,
			"route.js": compiled.code,
		},
	};
	type RenderResult =
		| { kind: "html"; html: string; cookies: readonly string[] }
		| {
				kind: "response";
				status: number;
				headers: Readonly<Record<string, string>>;
				body: string | null;
				cookies: readonly string[];
		  };
	let result: RenderResult;
	try {
		result = await host.executor.runOnce<RenderResult>(task, {
			url: url.href,
			method: request.method,
			props: {},
			params: {},
		});
	} catch (err) {
		host.logger.event("preview.render.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		return new Response(`render failed: ${(err as Error).message}`, {
			status: 500,
			headers: { "content-type": "text/plain;charset=utf-8" },
		});
	}
	if (result.kind === "response") {
		const headers = new Headers(result.headers);
		for (const cookie of result.cookies) headers.append("set-cookie", cookie);
		return new Response(result.body, { status: result.status, headers });
	}
	const headers = new Headers({ "content-type": "text/html;charset=utf-8" });
	for (const cookie of result.cookies) headers.append("set-cookie", cookie);
	return new Response(result.html, { status: 200, headers });
}

async function handleFileWrite(req: Request, env: PreviewWorkerEnv, host: Host): Promise<Response> {
	if (env.DEPLOY_TOKEN) {
		const auth = req.headers.get("authorization");
		if (auth !== `Bearer ${env.DEPLOY_TOKEN}`) {
			return new Response("unauthorized", { status: 401 });
		}
	}
	const url = new URL(req.url);
	const path = url.searchParams.get("path");
	if (!path || !path.startsWith("/")) {
		return new Response("missing or invalid ?path", { status: 400 });
	}
	const bytes = new Uint8Array(await req.arrayBuffer());
	await host.storage.write(path, bytes);
	const stat = await host.storage.stat(path);
	if (stat) {
		// `onFileChanged` updates the module-graph node and publishes
		// an HMR `update` for `path` + transitive importers.
		await host.coordinator.onFileChanged(path, stat.hash);
	}
	return new Response(JSON.stringify({ path, size: bytes.byteLength, hash: stat?.hash ?? null }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function handleHmr(req: Request, host: Host): Promise<Response> {
	return host.transport.acceptHmrSocket(req, { workspaceId: WORKSPACE_ID });
}

export default {
	async fetch(req: Request, env: PreviewWorkerEnv): Promise<Response> {
		const host = makeHost(env);
		const url = new URL(req.url);

		if (url.pathname === "/_aflare/preview/info") {
			return new Response(JSON.stringify({ previewWorker: true, workspaceId: WORKSPACE_ID }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname === "/_aflare/file" && req.method === "POST") {
			return handleFileWrite(req, env, host);
		}
		if (url.pathname === "/_aflare/hmr") {
			return handleHmr(req, host);
		}
		// Reserve `/_aflare/*` for framework endpoints; never resolve
		// it as a route.
		if (url.pathname.startsWith("/_aflare/")) {
			return new Response("Not found", { status: 404 });
		}

		const sourcePath = pathnameToSourcePath(url.pathname);
		return renderRoute(host, sourcePath, req);
	},
};
