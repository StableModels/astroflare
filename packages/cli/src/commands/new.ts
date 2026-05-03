/**
 * `af new <dir>` — scaffold a fresh project from `@astroflare/starter`.
 *
 * Lays down the canonical starter scaffold (layout, index page,
 * markdown route, dynamic [slug] route via `getStaticPaths`, content
 * collection, public asset, project config). The same files are
 * available programmatically via `getStarterFiles()` from the same
 * package, so on-disk + in-Worker materialisation produce
 * byte-identical output.
 *
 * For the legacy minimal scaffold (just `index.astro` + `about.astro`),
 * use `af init`.
 */

import { writeStarterFiles } from "@astroflare/starter/node";

export interface NewOptions {
	dir: string;
	force?: boolean;
}

export interface NewResult {
	created: readonly string[];
	skipped: readonly string[];
}

export function newProject(opts: NewOptions): NewResult {
	return writeStarterFiles({ dir: opts.dir, force: opts.force ?? false });
}
