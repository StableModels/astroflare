/**
 * `SiteDurableObject` — reference host SiteDO for the Phase 26
 * host-driven preview architecture.
 *
 * Owns:
 *   - The Workspace (`@cloudflare/shell`) — source files for one
 *     Astroflare site, persisted in DO sqlite.
 *   - The hash sidecar (`aflare_hash` table, populated by `WorkspaceSite.write`).
 *   - Astroflare's coordinator (`createCoordinator`) — module graph,
 *     change pipeline, HMR fanout. Tables prefixed `aflare_*`.
 *   - The HMR WebSocket endpoint (browsers connect at `/_aflare/hmr`).
 *
 * Routes inside the DO:
 *   - GET /            — render via `createPreviewHandler`
 *   - GET /<route>     — same
 *   - GET /_aflare/hmr — WS upgrade
 *   - POST /_aflare/site/file?path=... — write a file (host-defined endpoint)
 *   - DELETE /_aflare/site/file?path=... — remove a file
 *   - GET /_aflare/site/info — diagnostic JSON
 *
 * The worker writes `/_aflare/site/file` are bearer-auth'd via
 * `env.DEPLOY_TOKEN`; the worker outside this DO routes those
 * requests after auth.
 */

import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/shell";
import {
	type AstroflareCoordinator,
	acceptHmrSocket,
	createCoordinator,
	createPreviewHandler,
	createWorkerdExecutor,
	SqlCache,
	WorkspaceSite,
} from "@astroflare/host-cloudflare";

interface Env {
	SITE_R2: R2Bucket;
	LOADER: WorkerLoader;
	DEPLOY_TOKEN?: string;
}

/**
 * Pre-built runtime modules. The host's bundler substitutes this with
 * a JSON object literal mapping `runtime/<name>.js` keys to the
 * compiled runtime source. Spawned compile/render isolates resolve
 * `import { render } from "./runtime/index.js"` against this map.
 */
declare const __AFLARE_RUNTIME_MODULES__: Record<string, string>;

const RUNTIME_MODULES: Record<string, string> =
	typeof __AFLARE_RUNTIME_MODULES__ !== "undefined" ? __AFLARE_RUNTIME_MODULES__ : {};

export class SiteDurableObject extends DurableObject<Env> {
	#ws: Workspace;
	#site: WorkspaceSite;
	#coordinator: AstroflareCoordinator;
	#cache: SqlCache;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#ws = new Workspace({
			sql: ctx.storage.sql,
			r2: env.SITE_R2,
			name: () => "site",
		});
		this.#site = new WorkspaceSite({
			workspace: this.#ws,
			sql: ctx.storage.sql,
		});
		this.#cache = new SqlCache(ctx.storage.sql);
		this.#coordinator = createCoordinator({
			sql: ctx.storage.sql,
			site: this.#site,
			ctx,
		});
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/_aflare/hmr") {
			return acceptHmrSocket(this.ctx, req, this.#coordinator);
		}

		if (url.pathname === "/_aflare/site/info") {
			const info = await this.#ws.getWorkspaceInfo();
			return Response.json({
				site: true,
				workspaceInfo: info,
				hmrConnections: this.#coordinator.hmrConnectionCount(),
			});
		}

		if (url.pathname === "/_aflare/site/file") {
			return this.#handleFileMutation(req, url);
		}

		// Fall through to the Astroflare preview handler.
		return createPreviewHandler({
			site: this.#site,
			coordinator: this.#coordinator,
			executor: createWorkerdExecutor({
				loader: this.env.LOADER,
				compatibilityDate: "2025-09-01",
				compatibilityFlags: ["nodejs_compat"],
				runtime: RUNTIME_MODULES,
			}),
			cache: this.#cache,
		}).fetch(req);
	}

	async #handleFileMutation(req: Request, url: URL): Promise<Response> {
		const token = this.env.DEPLOY_TOKEN;
		if (token) {
			const auth = req.headers.get("authorization");
			if (auth !== `Bearer ${token}`) {
				return new Response("unauthorized", { status: 401 });
			}
		}
		const path = url.searchParams.get("path");
		if (!path || !path.startsWith("/")) {
			return new Response("missing or invalid ?path", { status: 400 });
		}

		if (req.method === "POST") {
			const bytes = new Uint8Array(await req.arrayBuffer());
			const { hash, event } = await this.#site.write(path, bytes);
			await this.#coordinator.notifyChanged(event);
			return Response.json({ path, size: bytes.byteLength, hash });
		}
		if (req.method === "DELETE") {
			const { existed, event } = await this.#site.remove(path);
			if (existed) await this.#coordinator.notifyChanged(event);
			return Response.json({ path, deleted: existed });
		}
		return new Response("method not allowed", { status: 405 });
	}

	// Hibernating WS lifecycle — delegate to the coordinator. These
	// are member methods on `DurableObject`; Cloudflare calls them
	// when waking the DO.
	override webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): void {
		this.#coordinator.webSocketMessage(ws, msg);
	}
	override webSocketClose(ws: WebSocket, code: number): void {
		this.#coordinator.webSocketClose(ws, code);
	}
}
