/**
 * `WorkspaceSite` — implements the framework's `Site` interface
 * against `@cloudflare/shell`'s `Workspace` (Phase 26).
 *
 * The `Site` interface requires `statFile(path)` to return a content
 * hash; `Workspace` doesn't track hashes natively. We maintain a
 * sidecar `aflare_hash` table in the same DO sqlite — populated on
 * every write through `WorkspaceSite.write` (a host-side helper, not
 * part of the read-only `Site` interface).
 *
 * Host integration shape:
 *
 *   const ws = new Workspace({ sql: ctx.storage.sql, r2: env.R2 });
 *   const site = new WorkspaceSite({ workspace: ws, sql: ctx.storage.sql });
 *   const coordinator = createCoordinator({ sql, site, ctx });
 *   ws.options.onChange = (e) => {
 *     // Wire workspace change events into the change pipeline.
 *     // (See createCoordinator for SiteChangeEvent shape.)
 *   };
 *
 * Hosts that want change notifications should pass the workspace
 * instance with `onChange` already wired (since `@cloudflare/shell`
 * takes the callback at construction).
 */

import type { Site, SiteChangeEvent } from "@astroflare/core";
import type { SqlBackend } from "./sql-cache.js";

/**
 * Subset of `@cloudflare/shell`'s `Workspace` we use. Letting the
 * caller pass any compatible shape keeps tests independent of the
 * `cloudflare:workers` runtime context that `@cloudflare/shell`
 * needs to instantiate.
 *
 * **Cross-DO use is supported.** `WorkspaceLike` is structurally
 * typed; hosts whose workspace lives in a different Durable Object
 * than the Astroflare pipeline can satisfy this interface with a
 * stub-forwarding proxy whose methods round-trip into the workspace
 * DO via RPC. In that topology the host's write path is *not*
 * `WorkspaceSite.write` — it's whatever cross-DO write the host
 * already has — so the framework can no longer maintain
 * `aflare_hash` automatically. Use {@link WorkspaceSite.recordExternalWrite}
 * / {@link WorkspaceSite.recordExternalDelete} on every external
 * write to keep the sidecar consistent; without them, the closure
 * cache key drifts and preview renders serve stale compiled output
 * even though the HMR socket fires.
 */
export interface WorkspaceLike {
	readFileBytes(path: string): Promise<Uint8Array | null>;
	writeFileBytes(path: string, bytes: Uint8Array | ArrayBuffer, mimeType?: string): Promise<void>;
	deleteFile(path: string): Promise<boolean>;
	stat(path: string): Promise<{ size: number } | null>;
	glob(pattern: string): Promise<readonly { path: string }[]>;
}

const HASH_SCHEMA = `
CREATE TABLE IF NOT EXISTS aflare_hash (
	path TEXT PRIMARY KEY,
	hash TEXT NOT NULL
);
`;

export interface WorkspaceSiteOptions {
	workspace: WorkspaceLike;
	sql: SqlBackend;
}

export class WorkspaceSite implements Site {
	readonly #ws: WorkspaceLike;
	readonly #sql: SqlBackend;
	#initialized = false;

	constructor(opts: WorkspaceSiteOptions) {
		this.#ws = opts.workspace;
		this.#sql = opts.sql;
	}

	#ensure(): void {
		if (this.#initialized) return;
		this.#sql.exec(HASH_SCHEMA);
		this.#initialized = true;
	}

	async readFile(path: string): Promise<Uint8Array | null> {
		const bytes = await this.#ws.readFileBytes(path);
		return bytes ?? null;
	}

	async statFile(path: string): Promise<{ size: number; hash: string } | null> {
		this.#ensure();
		const stat = await this.#ws.stat(path);
		if (!stat) return null;
		const rows = this.#sql
			.exec<{ hash: string }>("SELECT hash FROM aflare_hash WHERE path = ?", path)
			.toArray();
		const first = rows[0];
		if (!first) {
			// Workspace has the file but we don't know the hash — the file
			// was written by a path that bypassed `WorkspaceSite.write`.
			// Compute on demand so callers always see a hash.
			const bytes = await this.#ws.readFileBytes(path);
			if (!bytes) return null;
			const hash = await sha256Hex(bytes);
			this.#sql.exec("INSERT OR REPLACE INTO aflare_hash (path, hash) VALUES (?, ?)", path, hash);
			return { size: stat.size, hash };
		}
		return { size: stat.size, hash: first.hash };
	}

	async *glob(pattern: string): AsyncIterable<string> {
		const matches = await this.#ws.glob(pattern);
		for (const m of matches) yield m.path;
	}

	// Host-side helpers — not part of the read-only Site interface.

	/**
	 * Write a file and update the hash sidecar. Returns the new hash
	 * + a `SiteChangeEvent` the host can pass to
	 * `coordinator.notifyChanged` for HMR fanout.
	 */
	async write(path: string, bytes: Uint8Array): Promise<{ hash: string; event: SiteChangeEvent }> {
		this.#ensure();
		const hash = await sha256Hex(bytes);
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		await this.#ws.writeFileBytes(path, copy);
		this.#sql.exec("INSERT OR REPLACE INTO aflare_hash (path, hash) VALUES (?, ?)", path, hash);
		return { hash, event: { kind: "write", path, hash } };
	}

	/**
	 * Delete a file and remove its hash entry. Returns a
	 * `SiteChangeEvent` for `coordinator.notifyChanged`.
	 */
	async remove(path: string): Promise<{ existed: boolean; event: SiteChangeEvent }> {
		this.#ensure();
		const existed = await this.#ws.deleteFile(path);
		this.#sql.exec("DELETE FROM aflare_hash WHERE path = ?", path);
		return { existed, event: { kind: "delete", path } };
	}

	/**
	 * Record that the workspace was written externally (by a path
	 * other than {@link WorkspaceSite.write}). Reads the new bytes
	 * back through the workspace, computes the SHA-256, refreshes
	 * `aflare_hash`, and returns a {@link SiteChangeEvent} ready for
	 * `coordinator.notifyChanged`.
	 *
	 * **Why this exists.** The hash sidecar (`aflare_hash`) is the
	 * load-bearing key for the closure-aware compile cache. The
	 * preview handler walks the import closure and looks up each
	 * module by its hash; if the sidecar is stale, the cache returns
	 * the old compiled bytes even after the source changed and the
	 * HMR socket fired. `WorkspaceSite.write` keeps the sidecar in
	 * step automatically — but hosts whose write path bypasses it
	 * (cross-DO writes, agent-driven writes through the workspace
	 * DO, externally-mounted filesystems) need to refresh the hash
	 * out-of-band. That's this method.
	 *
	 * **Cross-DO use.** When the workspace lives in DO A and the
	 * Astroflare pipeline lives in DO B, the canonical wiring is:
	 *
	 *   1. The host writes through DO A (no `WorkspaceSite.write`).
	 *   2. DO A forwards the change into DO B via RPC.
	 *   3. DO B calls `site.recordExternalWrite(path)` followed by
	 *      `coordinator.notifyChanged(event)`.
	 *
	 * Returns `null` if the file is no longer present in the
	 * workspace at the moment of the call (race against a concurrent
	 * delete) — the caller should drop the change in that case.
	 */
	async recordExternalWrite(
		path: string,
	): Promise<{ hash: string; event: SiteChangeEvent } | null> {
		this.#ensure();
		const bytes = await this.#ws.readFileBytes(path);
		if (!bytes) return null;
		const hash = await sha256Hex(bytes);
		this.#sql.exec("INSERT OR REPLACE INTO aflare_hash (path, hash) VALUES (?, ?)", path, hash);
		return { hash, event: { kind: "write", path, hash } };
	}

	/**
	 * Mirror of {@link recordExternalWrite} for deletes. Drops the
	 * `aflare_hash` row and returns a {@link SiteChangeEvent} ready
	 * for `coordinator.notifyChanged`. Idempotent — safe to call for
	 * paths that were never tracked.
	 */
	async recordExternalDelete(path: string): Promise<{ event: SiteChangeEvent }> {
		this.#ensure();
		this.#sql.exec("DELETE FROM aflare_hash WHERE path = ?", path);
		return { event: { kind: "delete", path } };
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// Copy into a fresh ArrayBuffer to satisfy `BufferSource` (the
	// generic Uint8Array<ArrayBufferLike> doesn't widen cleanly when
	// site-workspace is included in the composite tsc graph).
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const buf = await crypto.subtle.digest("SHA-256", copy.buffer);
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hex;
}
