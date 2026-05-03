/**
 * `findOrphanWorkers` — sweep orphan Worker scripts left in the
 * Cloudflare account that don't appear in any `.state/<sha7>/`
 * directory locally. Useful after a crashed CI run, a mistake
 * cleanup, or a debug session that didn't reach its `teardown`.
 *
 * Returns the orphan list rather than deleting unprompted — caller
 * decides whether to print or to follow up with
 * `client.deleteWorker(name)`.
 */

import { existsSync, readdirSync } from "node:fs";
import type { CloudflareClient } from "../api.js";

export interface GcInput {
	rootDir: string;
	client: CloudflareClient;
	/** Only consider Workers whose name starts with this prefix as
	 *  candidates (so we don't propose deleting unrelated scripts in
	 *  the account). Default `aflare-`. */
	namePrefix?: string;
}

export interface GcResult {
	orphans: readonly { id: string; created_on?: string }[];
	knownLocal: readonly string[];
}

const DEFAULT_PREFIX = "aflare-";

export async function findOrphanWorkers(input: GcInput): Promise<GcResult> {
	const prefix = input.namePrefix ?? DEFAULT_PREFIX;
	const knownLocal = collectKnownWorkers(input.rootDir);
	const live = await input.client.listWorkers();
	const orphans = live
		.filter((w) => w.id.startsWith(prefix))
		.filter((w) => !knownLocal.includes(w.id));
	return { orphans, knownLocal };
}

/**
 * Walk every `tests/e2e/.state/<sha7>/<name>.json` and rebuild the
 * worker-name set. We don't read each file — the worker name is
 * deterministic (`aflare-<name>-<sha>`), so the SHA + name encoded
 * in the path are enough.
 */
function collectKnownWorkers(rootDir: string): string[] {
	const stateDir = `${rootDir}/tests/e2e/.state`;
	if (!existsSync(stateDir)) return [];
	const out: string[] = [];
	for (const sha of readdirSync(stateDir)) {
		const shaDir = `${stateDir}/${sha}`;
		if (!existsSync(shaDir)) continue;
		for (const filename of readdirSync(shaDir)) {
			if (!filename.endsWith(".json")) continue;
			const fixture = filename.slice(0, -".json".length);
			out.push(`aflare-${fixture}-${sha}`);
		}
	}
	return out;
}
