/**
 * `R2Storage` — production-shaped `Storage` backed by Cloudflare R2.
 *
 * Two keyspaces, multiplexed by prefix in a single R2 bucket:
 *   - `files/<workspace-path>` — the user's project tree. The leading `/`
 *     of workspace paths is stripped so R2 keys stay POSIX-clean.
 *   - `cache/<sha>` — the content-addressed compile-cache subspace
 *     (§5.3 of the brief).
 *
 * Why a single bucket: hosts can split later by passing a separate
 * `cacheBucket`, but the default keeps wrangler.toml minimal — one
 * binding, two prefixes.
 *
 * SHA-256 hashes are stamped into R2 object metadata at write time so
 * `stat` doesn't have to GET the bytes back. Externally-written objects
 * (e.g. files uploaded directly via `wrangler r2 object put` outside the
 * framework) lack the metadata; we fall back to fetching the bytes and
 * computing the hash. Subsequent stats hit the metadata fast path
 * because we don't re-PUT externally-uploaded objects.
 *
 * `glob` extracts the literal prefix before the first wildcard
 * (`*` / `?` / `[` / `{`) and uses R2 LIST under that prefix, then
 * post-filters with the framework's `globToRegex`. R2 LIST is
 * paginated (1k objects/page); the `for await` in the framework's
 * code drives the pagination naturally.
 *
 * Carve-outs (Phase 15 — defer until a host actually needs them):
 *   - Custom-domain bucket routing — ProjectWorkers bind one bucket;
 *     multi-tenant workspaces would route per-workspace by prefix
 *     instead of per-bucket.
 *   - Multipart uploads / streaming — `write` reads the whole `bytes`
 *     in. Files >100 MB would need multipart; framework code never
 *     emits files that big.
 *   - Conditional writes (etag preconditions). Framework writes are
 *     last-write-wins, which matches the `Storage` contract.
 */

import { type FileStat, type Storage, contentId, globToRegex } from "@astroflare/core";

/**
 * R2 key prefixes. Keep the trailing slash so `${PREFIX}${path}` joins
 * cleanly without intermediate logic.
 */
const FILES_PREFIX = "files/";
const CACHE_PREFIX = "cache/";

/** Custom-metadata key holding the SHA-256 hex of the object's bytes. */
const HASH_META_KEY = "aflare-sha";

export interface R2StorageOptions {
	/** R2 bucket binding — used for both file and cache subspaces. */
	bucket: R2Bucket;
	/**
	 * Optional separate R2 bucket for the cache keyspace. If absent,
	 * `bucket` is used with the `cache/` prefix. Tests typically pass
	 * one bucket; production hosts may split for retention policies.
	 */
	cacheBucket?: R2Bucket;
}

export class R2Storage implements Storage {
	readonly #bucket: R2Bucket;
	readonly #cacheBucket: R2Bucket;

	constructor(opts: R2StorageOptions) {
		this.#bucket = opts.bucket;
		this.#cacheBucket = opts.cacheBucket ?? opts.bucket;
	}

	async read(path: string): Promise<Uint8Array> {
		const obj = await this.#bucket.get(this.#fileKey(path));
		if (!obj) throw new Error(`R2Storage.read: not found: ${path}`);
		return new Uint8Array(await obj.arrayBuffer());
	}

	async write(path: string, bytes: Uint8Array): Promise<void> {
		const hash = await contentId(bytes);
		// R2's PUT accepts ArrayBuffer directly. Copy into a fresh ArrayBuffer
		// to satisfy `BodyInit` (the input may be a Uint8Array view onto a
		// SharedArrayBuffer, which `R2Bucket.put` doesn't accept).
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		await this.#bucket.put(this.#fileKey(path), copy.buffer, {
			customMetadata: { [HASH_META_KEY]: hash },
		});
	}

	async remove(path: string): Promise<void> {
		await this.#bucket.delete(this.#fileKey(path));
	}

	async *glob(pattern: string): AsyncIterable<string> {
		const re = globToRegex(pattern);
		const literal = literalPrefix(pattern);
		// LIST under `files/<literal-prefix>` so the page size is bounded
		// to the relevant subtree. R2 LIST is paginated; iterate via
		// `cursor` until `truncated: false`.
		let cursor: string | undefined;
		while (true) {
			const result: R2Objects = await this.#bucket.list({
				prefix: this.#fileKey(literal),
				cursor,
			});
			for (const o of result.objects) {
				const path = filePathFromKey(o.key);
				if (path && re.test(path)) yield path;
			}
			if (!result.truncated) break;
			cursor = result.cursor;
		}
	}

	async stat(path: string): Promise<FileStat | null> {
		const head = await this.#bucket.head(this.#fileKey(path));
		if (!head) return null;
		const stamped = head.customMetadata?.[HASH_META_KEY];
		if (stamped) {
			return { size: head.size, hash: stamped };
		}
		// Externally-written (or older) object without our hash metadata.
		// Fetch + hash. We deliberately don't re-PUT to add the metadata;
		// hosts may have stricter ACLs on writes.
		const obj = await this.#bucket.get(this.#fileKey(path));
		if (!obj) return null;
		const bytes = new Uint8Array(await obj.arrayBuffer());
		const hash = await contentId(bytes);
		return { size: bytes.length, hash };
	}

	async cacheRead(hash: string): Promise<Uint8Array | null> {
		const obj = await this.#cacheBucket.get(`${CACHE_PREFIX}${hash}`);
		if (!obj) return null;
		return new Uint8Array(await obj.arrayBuffer());
	}

	async cacheWrite(hash: string, bytes: Uint8Array): Promise<void> {
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		await this.#cacheBucket.put(`${CACHE_PREFIX}${hash}`, copy.buffer);
	}

	#fileKey(path: string): string {
		// Strip leading `/`. R2 keys are bare relative paths; the framework's
		// `Storage` interface uses absolute POSIX paths.
		const norm = path.startsWith("/") ? path.slice(1) : path;
		return `${FILES_PREFIX}${norm}`;
	}
}

/**
 * Recover a workspace path from an R2 key in the files subspace. Returns
 * null for keys outside the files subspace (e.g. cache entries when LIST
 * runs against the bucket root).
 */
function filePathFromKey(key: string): string | null {
	if (!key.startsWith(FILES_PREFIX)) return null;
	return `/${key.slice(FILES_PREFIX.length)}`;
}

/**
 * Longest leading literal portion of a glob — i.e. everything before the
 * first wildcard. `/src/pages/**​/*.astro` → `/src/pages/`. Used as the
 * R2 LIST prefix so we don't list the entire bucket on every glob call.
 */
function literalPrefix(pattern: string): string {
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i] as string;
		if (c === "*" || c === "?" || c === "[" || c === "{") break;
		i++;
	}
	return pattern.slice(0, i);
}
