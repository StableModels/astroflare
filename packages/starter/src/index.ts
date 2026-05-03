/**
 * `@astroflare/starter` — canonical minimum-viable Astroflare scaffold.
 *
 * Two consumption modes, both byte-identical:
 *
 *   1. Programmatic (workers-runtime safe). Hosts that materialize a
 *      fresh site from inside a Worker / DO call `getStarterFiles()`,
 *      iterate the map, and `WorkspaceSite.write(path, bytes)` each
 *      entry:
 *
 *      ```ts
 *      import { getStarterFiles } from "@astroflare/starter";
 *      const files = getStarterFiles();
 *      for (const [path, bytes] of Object.entries(files)) {
 *        await siteWorkspace.write(`/${path}`, bytes);
 *      }
 *      ```
 *
 *   2. CLI / on-disk (Node only). `af new <dir>` (CLI) or
 *      `writeStarterFiles({ dir })` (library) creates the same files
 *      on disk. Lives in `./node.js` so the workers-runtime entry
 *      doesn't import `node:fs`.
 *
 * The shipped files demonstrate Astroflare's headline features:
 * layout component, index route, markdown route, dynamic route via
 * `getStaticPaths`, content collection with Zod schema, public
 * asset, project config.
 *
 * The recommended seed for any host embedding Astroflare in a
 * multi-tenant or agent workflow: scaffold a workspace, hand the
 * agent control of `src/`.
 */

import { STARTER_FILES_BASE64 } from "./starter-files.generated.js";

/**
 * Paths (no leading `/`) of every file shipped in the scaffold.
 * Sorted alphabetically — stable order is part of the public contract
 * so consumers iterating the map see the same sequence every time.
 */
export const starterFilePaths: readonly string[] = Object.freeze(
	Object.keys(STARTER_FILES_BASE64).sort(),
);

/**
 * Inlined raw bytes of every starter file, keyed by POSIX-style
 * relative path (no leading `/`). Workers-runtime safe — no
 * `node:fs`, no `node:path`. Decoded lazily on first call.
 *
 * The returned map is fresh on each call (defensive copy) so
 * consumers can mutate it without polluting future calls.
 */
export function getStarterFiles(): Record<string, Uint8Array> {
	const out: Record<string, Uint8Array> = {};
	for (const path of starterFilePaths) {
		out[path] = decodeBase64(STARTER_FILES_BASE64[path] as string);
	}
	return out;
}

/**
 * Decoded UTF-8 text content of a single starter file. Returns `null`
 * for unknown paths. Convenience for hosts that want to peek without
 * decoding the full set.
 */
export function getStarterFile(path: string): Uint8Array | null {
	const b64 = STARTER_FILES_BASE64[path];
	if (!b64) return null;
	return decodeBase64(b64);
}

/**
 * Decode a base64 string into a `Uint8Array`. Uses `atob` (available
 * in Workers + Node 18+) so this entry stays workers-runtime safe.
 */
function decodeBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export const STARTER_VERSION = "0.0.0";
