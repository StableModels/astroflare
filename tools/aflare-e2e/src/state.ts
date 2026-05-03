/**
 * Per-fixture state store — `tests/e2e/.state/<sha7>/<fixture>.json`.
 *
 * Provisioning a fixture writes a small JSON document recording the
 * resources it owns (Worker name, R2 bucket name, deployed URL).
 * Subsequent commands (`run`, `teardown`) read that document instead
 * of round-tripping the API. Names are deterministic
 * (`aflare-e2e-<fixture>-<sha7>`) so concurrent CI runs on different
 * SHAs share nothing.
 *
 * The directory is gitignored (`tests/e2e/.state/`) so leaked state
 * from a crashed run never lands in git; `gc` (deferred to Phase 20a)
 * sweeps orphans by listing the live account.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FixtureState {
	fixture: string;
	sha7: string;
	workerName: string;
	bucketName: string;
	url: string;
	provisionedAt: string; // ISO timestamp
}

export function fixtureStatePath(rootDir: string, sha7: string, fixture: string): string {
	return `${rootDir}/tests/e2e/.state/${sha7}/${fixture}.json`;
}

export function readFixtureState(
	rootDir: string,
	sha7: string,
	fixture: string,
): FixtureState | null {
	const path = fixtureStatePath(rootDir, sha7, fixture);
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, "utf8");
	return JSON.parse(raw) as FixtureState;
}

export function writeFixtureState(rootDir: string, state: FixtureState): void {
	const path = fixtureStatePath(rootDir, state.sha7, state.fixture);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2));
}

export function deleteFixtureState(rootDir: string, sha7: string, fixture: string): void {
	const path = fixtureStatePath(rootDir, sha7, fixture);
	if (existsSync(path)) rmSync(path);
}
