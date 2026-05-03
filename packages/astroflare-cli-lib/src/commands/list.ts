/**
 * `aflare-e2e list` — enumerate fixtures provisioned in the current
 * SHA's state directory. The output is what `run`, `teardown`, and
 * `status` operate on — it never round-trips the Cloudflare API.
 *
 * Companion `gc` (deferred to Phase 20a) walks the live account
 * via `client.listWorkers()` to find orphans not reflected in
 * local state.
 */

import { existsSync, readdirSync } from "node:fs";
import { type FixtureState, readFixtureState } from "../state.js";

export interface ListInput {
	rootDir: string;
	sha7: string;
}

export function listFixtures(input: ListInput): readonly FixtureState[] {
	const dir = `${input.rootDir}/tests/e2e/.state/${input.sha7}`;
	if (!existsSync(dir)) return [];
	const out: FixtureState[] = [];
	for (const filename of readdirSync(dir)) {
		if (!filename.endsWith(".json")) continue;
		const fixture = filename.slice(0, -".json".length);
		const state = readFixtureState(input.rootDir, input.sha7, fixture);
		if (state) out.push(state);
	}
	return out;
}
