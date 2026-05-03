/**
 * `@astroflare/starter/node` — Node-only on-disk materialisation.
 *
 * Backs the `af new <dir>` CLI verb and any Node-side host that wants
 * to scaffold a fresh project on the local filesystem. Decodes the
 * exact same byte-content the workers-runtime `getStarterFiles()`
 * exposes, so the two consumption modes produce byte-identical files.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getStarterFiles, starterFilePaths } from "./index.js";

export interface WriteStarterFilesOptions {
	/** Destination directory. Created (recursively) if missing. */
	dir: string;
	/**
	 * If `true`, overwrite any pre-existing files. Defaults to `false`
	 * — conflicting files are skipped and reported in the result.
	 */
	force?: boolean;
}

export interface WriteStarterFilesResult {
	created: readonly string[];
	skipped: readonly string[];
}

/**
 * Materialise the starter project on disk. Idempotent in the
 * not-`force` mode: re-running over a partially-populated directory
 * fills in missing files and reports the rest as `skipped`.
 *
 * Throws when the destination is non-empty and contains files that
 * conflict with the scaffold and `force` is not set.
 */
export function writeStarterFiles(opts: WriteStarterFilesOptions): WriteStarterFilesResult {
	const { dir, force = false } = opts;
	if (existsSync(dir)) {
		const existing = readdirSync(dir);
		const conflict = existing.some((name) => starterFilePaths.includes(name));
		if (conflict && !force) {
			throw new Error(
				`writeStarterFiles: ${dir} already contains scaffold files (use force: true to overwrite)`,
			);
		}
	}

	const files = getStarterFiles();
	const created: string[] = [];
	const skipped: string[] = [];
	for (const path of starterFilePaths) {
		const full = join(dir, path);
		if (existsSync(full) && !force) {
			skipped.push(path);
			continue;
		}
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, files[path] as Uint8Array);
		created.push(path);
	}
	return { created, skipped };
}
