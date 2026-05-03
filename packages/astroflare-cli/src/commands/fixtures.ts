/**
 * Filesystem bridge for the `provision` verb (and the e2e test
 * suite's globalSetup, which uses these same helpers via the
 * `@astroflare/e2e` library).
 *
 * Reads the per-fixture Worker bundle from
 * `tests/e2e/fixtures/<name>/worker.js`. When the framework's deploy
 * pipeline matures (Phase 20b — bundle Astroflare itself for
 * fixtures) this helper is replaced by the framework's own bundle
 * producer.
 */

import { existsSync, readFileSync } from "node:fs";

export async function loadFixtureBundle(name: string, rootDir: string): Promise<string> {
	const path = `${rootDir}/tests/e2e/fixtures/${name}/worker.js`;
	if (!existsSync(path)) {
		throw new Error(`no Worker bundle for fixture '${name}' (expected ${path})`);
	}
	return readFileSync(path, "utf8");
}
