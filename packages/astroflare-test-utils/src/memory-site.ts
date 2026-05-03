/**
 * In-memory `Site` + `Cache` implementations (Phase 26 / 26b
 * post-finalization). Used as the substrate for Layer A tests:
 * `MemorySite` + `MemoryCache` + `MapCoordinator` + `InProcessExecutor`
 * exercise framework code paths in plain Node, without workerd or
 * Miniflare.
 *
 * Replaces the read-side responsibilities of `MemoryStorage`:
 *   - `MemorySite.readFile/statFile/glob` ↔ Storage.read/stat/glob
 *   - `MemoryCache.get/put` ↔ Storage.cacheRead/cacheWrite
 *
 * `MemorySite` exposes a non-interface `write(path, bytes)` helper
 * for tests that need to seed files (the `Site` interface itself is
 * read-only; writes are a host concern).
 */

import { type Cache, type FileStat, type Site, contentId, globToRegex } from "@astroflare/core";

export class MemorySite implements Site {
	readonly #files = new Map<string, Uint8Array>();
	readonly #stat = new Map<string, FileStat>();

	async readFile(path: string): Promise<Uint8Array | null> {
		const bytes = this.#files.get(path);
		return bytes ? new Uint8Array(bytes) : null;
	}

	async statFile(path: string): Promise<FileStat | null> {
		const bytes = this.#files.get(path);
		if (!bytes) return null;
		const cached = this.#stat.get(path);
		if (cached && cached.size === bytes.length) return cached;
		const hash = await contentId(bytes);
		const entry: FileStat = { size: bytes.length, hash };
		this.#stat.set(path, entry);
		return entry;
	}

	async *glob(pattern: string): AsyncIterable<string> {
		const re = globToRegex(pattern);
		const paths = Array.from(this.#files.keys()).sort();
		for (const p of paths) if (re.test(p)) yield p;
	}

	// --- host-side helpers (not part of Site) ---

	/** Write a file. Defensive copy. */
	write(path: string, bytes: Uint8Array): void {
		const copy = new Uint8Array(bytes);
		this.#files.set(path, copy);
		this.#stat.delete(path);
	}

	/** Remove a file. */
	remove(path: string): void {
		this.#files.delete(path);
		this.#stat.delete(path);
	}

	/** All file paths currently stored, sorted. */
	files(): string[] {
		return Array.from(this.#files.keys()).sort();
	}

	/** Total bytes across all files. */
	totalBytes(): number {
		let sum = 0;
		for (const v of this.#files.values()) sum += v.length;
		return sum;
	}

	/** Snapshot count of files. */
	count(): number {
		return this.#files.size;
	}
}

export class MemoryCache implements Cache {
	readonly #cache = new Map<string, Uint8Array>();

	async get(hash: string): Promise<Uint8Array | null> {
		const bytes = this.#cache.get(hash);
		return bytes ? new Uint8Array(bytes) : null;
	}

	async put(hash: string, bytes: Uint8Array): Promise<void> {
		this.#cache.set(hash, new Uint8Array(bytes));
	}

	// --- test affordances ---

	/** All cache keys currently stored, sorted. */
	keys(): string[] {
		return Array.from(this.#cache.keys()).sort();
	}

	/** Number of entries. */
	size(): number {
		return this.#cache.size;
	}
}
