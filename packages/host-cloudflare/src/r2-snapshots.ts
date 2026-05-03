/**
 * `R2Snapshots` / `R2SnapshotSink` — Mode B serve + write adapters
 * for snapshots stored in an R2 bucket (Phase 26b).
 *
 * Layout (host-controlled via `prefix`):
 *
 *   <prefix><snapshotHash>/_meta.json         — { contentType, hash } per route
 *   <prefix><snapshotHash>/<route-key>        — rendered bytes
 *   <prefix>current                            — UTF-8 bytes of the active snapshot hash
 *
 * The `prefix` parameter lets hosts run multi-environment + multi-site
 * deploys without forking the adapter:
 *
 *   new R2Snapshots({ bucket: env.SITES_PROD,    prefix: "sites/abc/" })
 *   new R2Snapshots({ bucket: env.SITES_PROD,    prefix: "sites/def/" })
 *   new R2Snapshots({ bucket: env.SITES_STAGING, prefix: "" })           // bucket-root
 *
 * Trailing slash is auto-normalised. Empty prefix means "store at the
 * bucket root."
 *
 * The `<route-key>` form is the URL pathname with the leading `/`
 * stripped; `/` itself maps to `index.html`. A `_meta.json` per
 * snapshot records the content-type and hash for each entry so the
 * serve handler can return correct headers without parsing filenames.
 */

import type { SnapshotEntry, SnapshotSink, Snapshots } from "@astroflare/core";

const CURRENT_KEY = "current";
const META_KEY = "_meta.json";

interface SnapshotMeta {
	entries: Record<string, { contentType: string; hash: string }>;
}

export interface R2SnapshotsOptions {
	bucket: R2Bucket;
	/** Path prefix within the bucket. Empty → bucket root. Trailing `/` normalised. */
	prefix?: string;
}

function normalizePrefix(p: string | undefined): string {
	if (!p) return "";
	if (p.endsWith("/")) return p;
	return `${p}/`;
}

function routeKey(route: string): string {
	const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
	if (trimmed === "") return "index.html";
	return trimmed;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

export class R2Snapshots implements Snapshots {
	readonly #bucket: R2Bucket;
	readonly #prefix: string;

	constructor(opts: R2SnapshotsOptions) {
		this.#bucket = opts.bucket;
		this.#prefix = normalizePrefix(opts.prefix);
	}

	async read(snapshotHash: string, route: string): Promise<SnapshotEntry | null> {
		const meta = await this.#readMeta(snapshotHash);
		if (!meta) return null;
		const key = routeKey(route);
		const entryMeta = meta.entries[key];
		if (!entryMeta) return null;
		const obj = await this.#bucket.get(`${this.#prefix}${snapshotHash}/${key}`);
		if (!obj) return null;
		const bytes = new Uint8Array(await obj.arrayBuffer());
		return {
			route,
			bytes,
			contentType: entryMeta.contentType,
			hash: entryMeta.hash,
		};
	}

	async current(): Promise<string | null> {
		const obj = await this.#bucket.get(`${this.#prefix}${CURRENT_KEY}`);
		if (!obj) return null;
		const text = (await obj.text()).trim();
		return text || null;
	}

	async list(): Promise<readonly string[]> {
		const seen = new Set<string>();
		let cursor: string | undefined;
		// LIST under our prefix; each top-level subdirectory is a snapshot
		// hash (we filter out `current`).
		while (true) {
			const result = await this.#bucket.list({
				prefix: this.#prefix,
				cursor,
				limit: 1000,
			});
			for (const obj of result.objects) {
				const rel = obj.key.slice(this.#prefix.length);
				if (rel === CURRENT_KEY) continue;
				const slash = rel.indexOf("/");
				if (slash === -1) continue;
				seen.add(rel.slice(0, slash));
			}
			if (!result.truncated) break;
			cursor = result.cursor;
		}
		return Array.from(seen).sort();
	}

	async #readMeta(snapshotHash: string): Promise<SnapshotMeta | null> {
		const obj = await this.#bucket.get(`${this.#prefix}${snapshotHash}/${META_KEY}`);
		if (!obj) return null;
		const text = await obj.text();
		return JSON.parse(text) as SnapshotMeta;
	}
}

export interface R2SnapshotSinkOptions {
	bucket: R2Bucket;
	prefix?: string;
}

export class R2SnapshotSink implements SnapshotSink {
	readonly #bucket: R2Bucket;
	readonly #prefix: string;
	readonly #pending = new Map<string, SnapshotMeta>();

	constructor(opts: R2SnapshotSinkOptions) {
		this.#bucket = opts.bucket;
		this.#prefix = normalizePrefix(opts.prefix);
	}

	async put(snapshotHash: string, entry: SnapshotEntry): Promise<void> {
		const key = routeKey(entry.route);
		// R2 PUT accepts ArrayBuffer; copy into a fresh buffer in case the
		// caller passed a Uint8Array view onto a SharedArrayBuffer.
		const copy = new Uint8Array(entry.bytes.byteLength);
		copy.set(entry.bytes);
		await this.#bucket.put(`${this.#prefix}${snapshotHash}/${key}`, copy.buffer, {
			httpMetadata: { contentType: entry.contentType },
		});
		const meta = this.#pending.get(snapshotHash) ?? { entries: {} };
		meta.entries[key] = { contentType: entry.contentType, hash: entry.hash };
		this.#pending.set(snapshotHash, meta);
	}

	async commit(snapshotHash: string): Promise<void> {
		const meta = this.#pending.get(snapshotHash);
		// Write meta first (entries already on disk); flip current last so
		// readers never see a current pointing at a snapshot whose meta is
		// not yet readable.
		if (meta) {
			await this.#bucket.put(
				`${this.#prefix}${snapshotHash}/${META_KEY}`,
				enc.encode(`${JSON.stringify(meta)}\n`),
				{ httpMetadata: { contentType: "application/json" } },
			);
		}
		await this.#bucket.put(`${this.#prefix}${CURRENT_KEY}`, enc.encode(snapshotHash), {
			httpMetadata: { contentType: "text/plain;charset=utf-8" },
		});
		this.#pending.delete(snapshotHash);
	}

	async abort(snapshotHash: string): Promise<void> {
		this.#pending.delete(snapshotHash);
		// Best-effort: leave any partially-written entries in place. R2 GC
		// is the host's concern; `Snapshots.list()` exposes orphans for
		// cleanup tooling.
	}
}

/** Decoder helper exposed for tests. */
export function decodeUtf8(bytes: Uint8Array): string {
	return dec.decode(bytes);
}
