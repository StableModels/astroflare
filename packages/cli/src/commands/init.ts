/**
 * `aflare init <dir>` — scaffold a new Astroflare project.
 *
 * Lays down a minimal, self-contained project that builds and
 * deploys cleanly:
 *
 *   <dir>/
 *     astro.config.json      — site URL placeholder, output: "static"
 *     package.json           — pinned @astroflare/cli dep + aflare scripts
 *     .gitignore             — node_modules, dist, .wrangler, .dev.vars
 *     src/
 *       pages/
 *         index.astro        — "Hello, Astroflare" greeting page
 *         about.astro        — second page so routing has something to match
 *
 * Pure-Node, dependency-free file writes — runs from the released
 * CLI binary without `pnpm install`. Idempotent: bails when the
 * directory exists with conflicting files (use `--force` to overwrite).
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface InitOptions {
	dir: string;
	force?: boolean;
	/** Project name baked into package.json. Defaults to the dir's basename. */
	name?: string;
	/** Pre-fill astro.config.json's `site`. Defaults to a placeholder. */
	site?: string;
}

export interface InitResult {
	created: readonly string[];
	skipped: readonly string[];
}

export function initProject(opts: InitOptions): InitResult {
	const baseName = opts.name ?? lastSegment(opts.dir);
	const site = opts.site ?? "https://example.com";

	const files = scaffoldFiles(baseName, site);
	const created: string[] = [];
	const skipped: string[] = [];

	if (existsSync(opts.dir)) {
		const conflict = readdirSync(opts.dir);
		if (conflict.length > 0 && !opts.force) {
			throw new Error(`directory ${opts.dir} is not empty (use --force to overwrite)`);
		}
	}

	for (const [rel, content] of Object.entries(files)) {
		const full = `${opts.dir}/${rel}`;
		if (existsSync(full) && !opts.force) {
			skipped.push(rel);
			continue;
		}
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
		created.push(rel);
	}

	return { created, skipped };
}

function scaffoldFiles(name: string, site: string): Record<string, string> {
	return {
		"astro.config.json": `${JSON.stringify(
			{
				site,
				output: "static",
			},
			null,
			2,
		)}\n`,
		"package.json": `${JSON.stringify(
			{
				name,
				version: "0.0.0",
				private: true,
				type: "module",
				scripts: {
					deploy: "af deploy",
					status: "af status",
				},
				dependencies: {
					"@astroflare/cli": "^0.0.0",
				},
			},
			null,
			2,
		)}\n`,
		".gitignore": "node_modules\ndist\n.wrangler\n.dev.vars\n",
		"src/pages/index.astro":
			'---\nconst greeting = "Hello, Astroflare";\n---\n<html><head><title>Hello</title></head>\n<body><h1>{greeting}</h1>\n<a href="/about">about</a></body></html>\n',
		"src/pages/about.astro":
			"---\n---\n<html><head><title>About</title></head>\n<body><p>About this Astroflare site.</p></body></html>\n",
	};
}

function lastSegment(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
