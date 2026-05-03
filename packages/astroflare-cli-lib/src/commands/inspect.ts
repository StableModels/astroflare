/**
 * `aflare-e2e inspect <fixture>` — show resource details for one
 * provisioned fixture. Reads the state file (single I/O); does not
 * round-trip the Cloudflare API. For live verification, use `status`.
 */

import { type FixtureState, readFixtureState } from "../state.js";

export interface InspectInput {
	rootDir: string;
	sha7: string;
	fixture: string;
}

export function inspectFixture(input: InspectInput): FixtureState | null {
	return readFixtureState(input.rootDir, input.sha7, input.fixture);
}
