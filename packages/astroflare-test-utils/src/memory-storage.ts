/**
 * In-memory `Storage` implementation.
 *
 * Two disjoint maps for the two keyspaces (file vs cache). Hashes are computed
 * lazily on `stat` and cached per (path, contentRef) so repeated stats are
 * cheap. `glob` walks the file map with the tiny matcher in `@astroflare/core`.
 *
 * Used as the substrate for Layer A tests (§8.A): `MemoryStorage` plus
 * `MapCoordinator` plus `InProcessExecutor` is enough to exercise every
 * framework-layer code path in plain Node, no workerd, no Miniflare.
 */
import { type FileStat, type Storage, contentId, globToRegex } from "@astroflare/core";

export class MemoryStorage implements Storage {
	readonly #files = new Map<string, Uint8Array>();
	readonly #cache = new Map<string, Uint8Array>();
	readonly #stat = new Map<string, FileStat>();

	async read(path: string): Promise<Uint8Array> {
		const bytes = this.#files.get(path);
		if (!bytes) throw new Error(`MemoryStorage.read: not found: ${path}`);
		return bytes;
	}

	async write(path: string, bytes: Uint8Array): Promise<void> {
		// Defensive copy — callers may reuse the buffer.
		const copy = new Uint8Array(bytes);
		this.#files.set(path, copy);
		this.#stat.delete(path); // invalidate cached stat
	}

	async remove(path: string): Promise<void> {
		this.#files.delete(path);
		this.#stat.delete(path);
	}

	async *glob(pattern: string): AsyncIterable<string> {
		const re = globToRegex(pattern);
		// Sort for stable iteration order (helps test snapshots).
		const paths = Array.from(this.#files.keys()).sort();
		for (const p of paths) if (re.test(p)) yield p;
	}

	async stat(path: string): Promise<FileStat | null> {
		const bytes = this.#files.get(path);
		if (!bytes) return null;
		const cached = this.#stat.get(path);
		if (cached && cached.size === bytes.length) return cached;
		const hash = await contentId(bytes);
		const entry: FileStat = { size: bytes.length, hash };
		this.#stat.set(path, entry);
		return entry;
	}

	async cacheRead(hash: string): Promise<Uint8Array | null> {
		const bytes = this.#cache.get(hash);
		return bytes ? new Uint8Array(bytes) : null;
	}

	async cacheWrite(hash: string, bytes: Uint8Array): Promise<void> {
		this.#cache.set(hash, new Uint8Array(bytes));
	}

	// --- test affordances (not part of the Storage interface) ---

	/** All file paths currently in the file keyspace. */
	files(): string[] {
		return Array.from(this.#files.keys()).sort();
	}

	/** All cache keys currently in the cache keyspace. */
	cacheKeys(): string[] {
		return Array.from(this.#cache.keys()).sort();
	}

	/** Number of bytes stored across both keyspaces. */
	totalBytes(): number {
		let sum = 0;
		for (const v of this.#files.values()) sum += v.length;
		for (const v of this.#cache.values()) sum += v.length;
		return sum;
	}
}
