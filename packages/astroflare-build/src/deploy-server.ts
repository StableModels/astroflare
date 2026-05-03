/**
 * Production-runtime serving shim.
 *
 * Wraps a `Host` (read-only) and serves rendered HTML for any URL whose
 * artifact exists at `/site/<currentDeployHash>/<output-path>`. For URLs
 * with no static artifact, returns 404 — Phase 8 will route through Worker
 * Loader for SSR routes.
 *
 * The brief calls this "Project Worker on production traffic". This file
 * is the framework-side function the host's worker entrypoint wraps.
 */

import type { Host } from "@astroflare/core";
import { readCurrent } from "./artifact.js";

export interface DeployServerOptions {
	host: Host;
	siteRoot?: string;
}

export interface DeployServer {
	fetch(req: Request): Promise<Response>;
}

const dec = new TextDecoder();

export function createDeployServer(opts: DeployServerOptions): DeployServer {
	const siteRoot = opts.siteRoot ?? "/site";

	return {
		async fetch(req: Request): Promise<Response> {
			try {
				const deployHash = await readCurrent(opts.host.storage, siteRoot);
				if (!deployHash) {
					return new Response("No deploy", {
						status: 503,
						headers: { "content-type": "text/plain;charset=utf-8" },
					});
				}
				const url = new URL(req.url);
				const candidates = candidatePaths(deployHash, siteRoot, url.pathname);

				for (const path of candidates) {
					const stat = await opts.host.storage.stat(path);
					if (!stat) continue;
					const bytes = await opts.host.storage.read(path);
					const body = dec.decode(bytes);
					return new Response(body, {
						status: 200,
						headers: {
							"content-type": contentTypeFor(path),
							"cache-control": "public, max-age=0, must-revalidate",
						},
					});
				}

				return new Response("Not found", {
					status: 404,
					headers: { "content-type": "text/plain;charset=utf-8" },
				});
			} catch (err) {
				opts.host.logger.event("deploy-server.error", {
					url: req.url,
					message: (err as Error).message,
				});
				return new Response("Internal error", { status: 500 });
			}
		},
	};
}

function candidatePaths(deployHash: string, siteRoot: string, pathname: string): string[] {
	const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
	const base = `${siteRoot}/${deployHash}`;
	const out: string[] = [];

	if (trimmed === "" || trimmed === "/") {
		out.push(`${base}/index.html`);
		return out;
	}

	const stripped = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
	out.push(`${base}/${stripped}/index.html`);
	out.push(`${base}/${stripped}.html`);
	out.push(`${base}/${stripped}`);
	return out;
}

function contentTypeFor(path: string): string {
	if (path.endsWith(".html")) return "text/html;charset=utf-8";
	if (path.endsWith(".css")) return "text/css;charset=utf-8";
	if (path.endsWith(".js")) return "application/javascript;charset=utf-8";
	if (path.endsWith(".json")) return "application/json;charset=utf-8";
	return "application/octet-stream";
}
