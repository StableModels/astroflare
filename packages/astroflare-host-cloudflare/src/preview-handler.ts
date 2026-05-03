/**
 * `createPreviewHandler` — request handler factory for Mode A
 * (in-Worker compile + render) under the host-driven architecture
 * (Phase 26). Replaces what `preview-worker.ts` did inline as the
 * canonical entrypoint.
 *
 * The host's worker (or DO) calls this with a `Site` capability, a
 * coordinator, and an executor; gets back a `{ fetch }` object it
 * can compose with its own routing.
 *
 * Default route mapping: `/<path>` → `/src/pages/<path>.astro`,
 * with `/` → `/src/pages/index.astro`. Hosts that want different
 * mapping wrap or replace this handler.
 *
 * The handler does **not** know about HMR upgrades, file writes,
 * or any `/_aflare/*` paths. Those are host concerns. If a host
 * wants to expose an HMR WebSocket, they call `acceptHmrSocket` on
 * the coordinator inside their own routing.
 */

import { DEFAULT_RUNTIME_IMPORT, buildRenderTask } from "@astroflare/build";
import { compileAstro } from "@astroflare/compiler/astro";
import type { Cache, Executor, Site } from "@astroflare/core";
import type { AstroflareCoordinator } from "./coordinator.js";

/** Subpath of the workspace where Astroflare looks up routes. */
const PAGES_PREFIX = "/src/pages";

const RUNTIME_IMPORT = DEFAULT_RUNTIME_IMPORT;

const dec = new TextDecoder();

export interface CreatePreviewHandlerOptions {
	site: Site;
	coordinator: AstroflareCoordinator;
	executor: Executor;
	cache?: Cache;
	/**
	 * Override the default URL → workspace path mapping. Receives
	 * `pathname`, returns the workspace path of the `.astro` file to
	 * compile, or `null` for "let the handler return 404."
	 *
	 * Default: `/foo` → `/src/pages/foo.astro`, `/` → `/src/pages/index.astro`.
	 */
	resolveRoute?: (pathname: string) => string | null;
	/** Optional structured logger; unused if absent. */
	logger?: { event(name: string, fields: Record<string, unknown>): void };
}

export interface PreviewHandler {
	fetch(req: Request): Promise<Response>;
}

export function createPreviewHandler(opts: CreatePreviewHandlerOptions): PreviewHandler {
	const resolveRoute = opts.resolveRoute ?? defaultResolveRoute;
	return {
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			const sourcePath = resolveRoute(url.pathname);
			if (!sourcePath) {
				return notFound();
			}
			return renderRoute(opts, sourcePath, req);
		},
	};
}

function defaultResolveRoute(pathname: string): string | null {
	const trimmed = pathname.replace(/\/+$/, "");
	const route = trimmed === "" ? "/index" : trimmed;
	return `${PAGES_PREFIX}${route}.astro`;
}

async function renderRoute(
	opts: CreatePreviewHandlerOptions,
	sourcePath: string,
	request: Request,
): Promise<Response> {
	const stat = await opts.site.statFile(sourcePath);
	if (!stat) return notFound();

	const sourceBytes = await opts.site.readFile(sourcePath);
	if (!sourceBytes) return notFound();
	const source = dec.decode(sourceBytes);

	let compiled: { code: string };
	try {
		compiled = await compileAstro(source, {
			filename: sourcePath,
			skipTsTransform: true,
			runtimeImport: RUNTIME_IMPORT,
		});
	} catch (err) {
		opts.logger?.event("preview.compile.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		return new Response(`compile failed: ${(err as Error).message}`, {
			status: 500,
			headers: { "content-type": "text/plain;charset=utf-8" },
		});
	}

	const url = new URL(request.url);
	const task = buildRenderTask({ routeCode: compiled.code, runtimeImport: RUNTIME_IMPORT });

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
		result = await opts.executor.runOnce<RenderResult>(task, {
			url: url.href,
			method: request.method,
			props: {},
			params: {},
		});
	} catch (err) {
		opts.logger?.event("preview.render.failed", {
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

function notFound(): Response {
	return new Response("Not found", {
		status: 404,
		headers: { "content-type": "text/plain;charset=utf-8" },
	});
}
