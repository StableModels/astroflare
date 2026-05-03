/**
 * `af inspect <name>` — show resource details for a managed host.
 * Reads the state file (single I/O); does not round-trip the
 * Cloudflare API. Phase 26c: handles both legacy fixture state and
 * stack state.
 */

import { type FixtureState, type StackState, readFixtureState, readStackState } from "../state.js";

export interface InspectInput {
	rootDir: string;
	sha7: string;
	/** Legacy field name; prefer `name`. */
	fixture?: string;
	name?: string;
}

export type InspectResult = ({ kind: "fixture" } & FixtureState) | ({ kind: "stack" } & StackState);

/**
 * Resolve a name to either a stack state (preferred) or a legacy
 * fixture state. Returns `null` if neither exists. Stack state wins
 * when both files exist (a fixture and a stack with the same name —
 * unusual but possible historically).
 */
export function inspectManaged(input: InspectInput): InspectResult | null {
	const name = input.name ?? input.fixture;
	if (!name) return null;
	const stack = readStackState(input.rootDir, input.sha7, name);
	if (stack) {
		const { kind: _k, ...rest } = stack;
		return { kind: "stack", ...rest } as InspectResult;
	}
	const fixture = readFixtureState(input.rootDir, input.sha7, name);
	if (fixture) return { kind: "fixture", ...fixture };
	return null;
}

/** Back-compat: fixture-only inspection. Prefer `inspectManaged`. */
export function inspectFixture(input: InspectInput): FixtureState | null {
	const r = inspectManaged(input);
	if (!r) return null;
	if (r.kind !== "fixture") return null;
	const { kind: _kind, ...rest } = r;
	return rest;
}
