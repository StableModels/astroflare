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

/**
 * Subset of `@cloudflare/shell`'s `Workspace` we use. Letting the
 * caller pass any compatible shape keeps tests independent of the
 * `cloudflare:workers` runtime context that `@cloudflare/shell`
 * needs to instantiate.
 */
export interface WorkspaceLike {
	readFileBytes(path: string): Promise<Uint8Array | null>;
	writeFileBytes(path: string, bytes: Uint8Array | ArrayBuffer, mimeType?: string): Promise<void>;
	deleteFile(path: string): Promise<boolean>;
	stat(path: string): Promise<{ size: number } | null>;
	glob(pattern: string): Promise<readonly { path: string }[]>;
}

/**
 * Subset of `SqlStorage` (DO sqlite) we use. Keeps the package free
 * of `cloudflare:workers` imports.
 */
export interface SqlBackend {
	exec<T = unknown>(
		query: string,
		...bindings: unknown[]
	): {
		toArray(): T[];
	};
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
		if (rows.length === 0) {
			// Workspace has the file but we don't know the hash — the file
			// was written by a path that bypassed `WorkspaceSite.write`.
			// Compute on demand so callers always see a hash.
			const bytes = await this.#ws.readFileBytes(path);
			if (!bytes) return null;
			const hash = await sha256Hex(bytes);
			this.#sql.exec("INSERT OR REPLACE INTO aflare_hash (path, hash) VALUES (?, ?)", path, hash);
			return { size: stat.size, hash };
		}
		return { size: stat.size, hash: rows[0].hash };
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
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", bytes);
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hex;
}
