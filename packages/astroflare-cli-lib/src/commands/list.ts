/**
 * `af list` — enumerate every entry in the current SHA's state
 * directory: legacy fixture workers (`<n>.json`) plus stack entries
 * (`<n>.stack.json`). Phase 26c: previously this only saw fixtures
 * and silently skipped stacks/preview entries.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { FixtureState, StackState } from "../state.js";

export interface ListInput {
	rootDir: string;
	sha7: string;
}

export type ManagedHost = ({ kind: "fixture" } & FixtureState) | ({ kind: "stack" } & StackState);

/**
 * Enumerate every managed host in the current SHA's state. Discriminated
 * on `kind` so callers can branch on the shape (fixture / stack).
 */
export function listManaged(input: ListInput): readonly ManagedHost[] {
	const dir = `${input.rootDir}/tests/e2e/.state/${input.sha7}`;
	if (!existsSync(dir)) return [];
	const out: ManagedHost[] = [];
	for (const filename of readdirSync(dir)) {
		if (!filename.endsWith(".json")) continue;
		const path = `${dir}/${filename}`;
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(raw) as { kind?: string };
			if (parsed.kind === "stack") {
				const { kind: _k, ...rest } = parsed as unknown as StackState;
				out.push({ kind: "stack", ...rest } as ManagedHost);
			} else if (!filename.endsWith(".preview.json") && !filename.endsWith(".stack.json")) {
				// Fixture (legacy) — `<n>.json` without a discriminator field.
				out.push({
					kind: "fixture",
					...(parsed as unknown as FixtureState),
				});
			}
		} catch {
			// Skip malformed; `inspect` surfaces structured errors per-entry.
		}
	}
	return out;
}

/** Back-compat: legacy fixture-only listing. Prefer `listManaged`. */
export function listFixtures(input: ListInput): readonly FixtureState[] {
	return listManaged(input)
		.filter((m): m is { kind: "fixture" } & FixtureState => m.kind === "fixture")
		.map(({ kind: _kind, ...rest }) => rest);
}
