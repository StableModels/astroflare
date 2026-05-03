/**
 * `LocalSite` — Node-side `Site` adapter for local filesystem
 * (Phase 26b finalization). Used by the CLI's `deployStaticBundle`
 * and by host applications that want to build from a checkout
 * rather than from a SiteDurableObject's Workspace.
 *
 * Read-only by design — `Site` is a read capability; writes go
 * through the host's own filesystem tooling.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Site } from "@astroflare/core";

export interface LocalSiteOptions {
	/** Root directory on local FS. Paths in `Site` calls are workspace-relative (`/foo` → `<dir>/foo`). */
	dir: string;
}

export class LocalSite implements Site {
	readonly #dir: string;

	constructor(opts: LocalSiteOptions) {
		this.#dir = resolve(opts.dir);
	}

	async readFile(path: string): Promise<Uint8Array | null> {
		const full = this.#resolve(path);
		if (!existsSync(full)) return null;
		const buf = await readFile(full);
		return new Uint8Array(buf);
	}

	async statFile(path: string): Promise<{ size: number; hash: string } | null> {
		const full = this.#resolve(path);
		if (!existsSync(full)) return null;
		const s = statSync(full);
		if (!s.isFile()) return null;
		const buf = readFileSync(full);
		const hash = createHash("sha256").update(buf).digest("hex");
		return { size: s.size, hash };
	}

	async *glob(pattern: string): AsyncIterable<string> {
		// Phase 26b: we only need recursive walks for buildSite right now;
		// pattern is honored as a simple suffix (`**/*.astro` → walk + filter on `.astro`).
		const ext = extractExtension(pattern);
		const root = this.#dir;
		yield* walkLocal(root, root, ext);
	}

	#resolve(path: string): string {
		const trimmed = path.replace(/^\/+/, "");
		return join(this.#dir, trimmed);
	}
}

function extractExtension(pattern: string): string | null {
	// "/**/*.astro" → ".astro"
	const m = pattern.match(/\.([a-z0-9]+)$/i);
	return m ? `.${m[1]}` : null;
}

async function* walkLocal(root: string, dir: string, ext: string | null): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkLocal(root, full, ext);
		} else if (entry.isFile()) {
			if (ext && !entry.name.endsWith(ext)) continue;
			const rel = relative(root, full).split(/[\\/]/).join("/");
			yield `/${rel}`;
		}
	}
}
