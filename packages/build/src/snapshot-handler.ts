/**
 * `createSnapshotHandler` — request handler that serves snapshot
 * entries (Phase 26b). Replaces `createDeployServer` from the
 * pre-North-Star shape.
 *
 * Stateless given a `Snapshots` capability. The host's worker
 * (or DO) calls this and gets back a `{ fetch }` it composes with
 * its own routing.
 *
 * Default URL → snapshot-route mapping:
 *   /            → /index.html (route key `index.html`)
 *   /about       → /about.html, /about/index.html (first match wins)
 *   /blog/post-1 → /blog/post-1.html, /blog/post-1/index.html
 *
 * Hosts that want different URL conventions wrap the handler.
 */

import type { SnapshotEntry, Snapshots } from "@astroflare/core";

export interface CreateSnapshotHandlerOptions {
	snapshots: Snapshots;
	/**
	 * Override the default `Cache-Control` policy. Receives the entry
	 * and the resolved snapshot hash; returns header values to merge.
	 *
	 * Default: HTML uses `public, max-age=0, must-revalidate`; everything
	 * else gets `public, max-age=3600`.
	 */
	cacheHeaders?: (entry: SnapshotEntry, snapshotHash: string) => Record<string, string>;
}

export interface SnapshotHandler {
	fetch(req: Request): Promise<Response>;
}

export function createSnapshotHandler(opts: CreateSnapshotHandlerOptions): SnapshotHandler {
	const cacheHeaders = opts.cacheHeaders ?? defaultCacheHeaders;
	return {
		async fetch(req: Request): Promise<Response> {
			try {
				const current = await opts.snapshots.current();
				if (!current) {
					return new Response("No deploy", {
						status: 503,
						headers: { "content-type": "text/plain;charset=utf-8" },
					});
				}
				const url = new URL(req.url);
				const candidates = candidateRoutes(url.pathname);
				for (const candidate of candidates) {
					const entry = await opts.snapshots.read(current, candidate);
					if (!entry) continue;
					const headers = new Headers({
						"content-type": entry.contentType,
						etag: `"${entry.hash}"`,
						...cacheHeaders(entry, current),
					});
					// Copy into a fresh ArrayBuffer so the Response sees a
					// concrete BodyInit (Uint8Array view-of-SharedArrayBuffer
					// can't satisfy BodyInit under the workers types).
					const body = new Uint8Array(entry.bytes.byteLength);
					body.set(entry.bytes);
					return new Response(body.buffer, { status: 200, headers });
				}
				return new Response("Not found", {
					status: 404,
					headers: { "content-type": "text/plain;charset=utf-8" },
				});
			} catch (err) {
				return new Response(`Internal error: ${(err as Error).message}`, { status: 500 });
			}
		},
	};
}

function candidateRoutes(pathname: string): string[] {
	const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
	if (trimmed === "" || trimmed === "/") return ["/"];
	return [`${trimmed}.html`, `${trimmed}/index.html`, trimmed];
}

function defaultCacheHeaders(entry: SnapshotEntry): Record<string, string> {
	if (entry.contentType.startsWith("text/html")) {
		return { "cache-control": "public, max-age=0, must-revalidate" };
	}
	return { "cache-control": "public, max-age=3600" };
}
