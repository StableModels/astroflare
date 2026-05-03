/**
 * `RestR2SnapshotSink` — Node-side `SnapshotSink` that writes
 * through the Cloudflare REST API (Phase 26b finalization). The
 * worker-runtime counterpart is `R2SnapshotSink` in
 * `@astroflare/host-cloudflare`; both produce the same wire layout:
 *
 *   <prefix><snapshotHash>/<route-key>     — entry bytes
 *   <prefix><snapshotHash>/_meta.json     — { entries: { <key>: { contentType, hash } } }
 *   <prefix>current                        — UTF-8 of active snapshot hash
 *
 * The CLI uses this to ship rendered HTML for `af deploy` /
 * `af deploy-static` without needing a Cloudflare-binding context.
 */

import type { SnapshotEntry, SnapshotSink } from "@astroflare/core";
import type { CloudflareClient } from "./api.js";

export interface RestR2SnapshotSinkOptions {
	client: CloudflareClient;
	bucket: string;
	prefix?: string;
}

interface SnapshotMeta {
	entries: Record<string, { contentType: string; hash: string }>;
}

function normalizePrefix(p: string | undefined): string {
	if (!p) return "";
	return p.endsWith("/") ? p : `${p}/`;
}

function routeKey(route: string): string {
	const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
	return trimmed === "" ? "index.html" : trimmed;
}

const enc = new TextEncoder();

export class RestR2SnapshotSink implements SnapshotSink {
	readonly #client: CloudflareClient;
	readonly #bucket: string;
	readonly #prefix: string;
	readonly #pending = new Map<string, SnapshotMeta>();

	constructor(opts: RestR2SnapshotSinkOptions) {
		this.#client = opts.client;
		this.#bucket = opts.bucket;
		this.#prefix = normalizePrefix(opts.prefix);
	}

	async put(snapshotHash: string, entry: SnapshotEntry): Promise<void> {
		const key = routeKey(entry.route);
		await this.#client.putR2Object({
			bucket: this.#bucket,
			key: `${this.#prefix}${snapshotHash}/${key}`,
			body: entry.bytes,
			contentType: entry.contentType,
		});
		const meta = this.#pending.get(snapshotHash) ?? { entries: {} };
		meta.entries[key] = { contentType: entry.contentType, hash: entry.hash };
		this.#pending.set(snapshotHash, meta);
	}

	async commit(snapshotHash: string): Promise<void> {
		const meta = this.#pending.get(snapshotHash);
		if (meta) {
			await this.#client.putR2Object({
				bucket: this.#bucket,
				key: `${this.#prefix}${snapshotHash}/_meta.json`,
				body: enc.encode(`${JSON.stringify(meta)}\n`),
				contentType: "application/json",
			});
		}
		await this.#client.putR2Object({
			bucket: this.#bucket,
			key: `${this.#prefix}current`,
			body: enc.encode(snapshotHash),
			contentType: "text/plain;charset=utf-8",
		});
		this.#pending.delete(snapshotHash);
	}

	async abort(snapshotHash: string): Promise<void> {
		this.#pending.delete(snapshotHash);
		// Best-effort: leave any partially-written entries in place. R2
		// GC is the host's concern.
	}
}
