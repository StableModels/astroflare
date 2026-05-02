/**
 * Deploy artifact format.
 *
 * Layout under `Storage`:
 *
 *   /site/<deployHash>/manifest.json     → DeployManifest
 *   /site/<deployHash>/<outputPath>      → rendered HTML, one per static route
 *   /site/current                        → bytes "<deployHash>" (atomic flip)
 *
 * The runtime serving function (`createDeployServer`) reads
 * `/site/current` to find the active deploy hash, then looks up
 * `/site/<deployHash>/<request-pathname>/index.html` for static
 * responses. SSR routes will route through Worker Loader at the same
 * `/site/<deployHash>/` prefix — Phase 7 ships static only; SSR follows
 * when getStaticPaths is implemented (it's the "give up on prerendering"
 * branch).
 */

import { type Storage, contentId } from "@astroflare/core";

export interface DeployManifestEntry {
	/** URL path the route serves. */
	url: string;
	/** Workspace path of the source file. */
	source: string;
	/** Deploy artifact path (relative to `/site/<deployHash>/`). */
	output: string;
	/** SHA-256 of the rendered HTML, hex. */
	digest: string;
}

export interface DeployManifest {
	deployHash: string;
	createdAt: number;
	routes: DeployManifestEntry[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Build a manifest from a set of rendered routes. */
export async function buildManifest(opts: {
	deployHash: string;
	createdAt: number;
	routes: readonly {
		url: string;
		source: string;
		output: string;
		html: string;
	}[];
}): Promise<DeployManifest> {
	const routes: DeployManifestEntry[] = [];
	for (const r of opts.routes) {
		const digest = await contentId(r.html);
		routes.push({ url: r.url, source: r.source, output: r.output, digest });
	}
	return {
		deployHash: opts.deployHash,
		createdAt: opts.createdAt,
		routes,
	};
}

/** Write the manifest to `/site/<deployHash>/manifest.json`. */
export async function writeManifest(
	storage: Storage,
	manifest: DeployManifest,
	siteRoot = "/site",
): Promise<void> {
	const path = `${siteRoot}/${manifest.deployHash}/manifest.json`;
	await storage.write(path, enc.encode(`${JSON.stringify(manifest, null, 2)}\n`));
}

/** Read the active deploy pointer (`/site/current`). Returns null if absent. */
export async function readCurrent(storage: Storage, siteRoot = "/site"): Promise<string | null> {
	const stat = await storage.stat(`${siteRoot}/current`);
	if (!stat) return null;
	const bytes = await storage.read(`${siteRoot}/current`);
	return dec.decode(bytes).trim();
}

/** Read a deploy's manifest. */
export async function readManifest(
	storage: Storage,
	deployHash: string,
	siteRoot = "/site",
): Promise<DeployManifest | null> {
	const path = `${siteRoot}/${deployHash}/manifest.json`;
	const stat = await storage.stat(path);
	if (!stat) return null;
	const bytes = await storage.read(path);
	return JSON.parse(dec.decode(bytes)) as DeployManifest;
}
