/**
 * `aflare-e2e status` — health check across every provisioned
 * fixture. Issues a `HEAD /` to each fixture's deployed URL,
 * collects (status, latencyMs) per fixture. Useful for CI to
 * verify a deploy is actually serving before driving the full
 * vitest e2e suite.
 *
 * Tests inject a `fetchImpl` mock so they don't reach the
 * network; production uses `globalThis.fetch`.
 */

import type { FixtureState } from "../state.js";
import { listFixtures } from "./list.js";

export interface StatusInput {
	rootDir: string;
	sha7: string;
	fetchImpl?: typeof fetch;
}

export interface FixtureStatus extends FixtureState {
	httpStatus: number | null;
	latencyMs: number | null;
	error: string | null;
}

export async function statusReport(input: StatusInput): Promise<readonly FixtureStatus[]> {
	const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const fixtures = listFixtures({ rootDir: input.rootDir, sha7: input.sha7 });
	const out: FixtureStatus[] = [];
	for (const f of fixtures) {
		const t0 = Date.now();
		try {
			const res = await fetchImpl(f.url, { method: "HEAD" });
			out.push({
				...f,
				httpStatus: res.status,
				latencyMs: Date.now() - t0,
				error: null,
			});
		} catch (err) {
			out.push({
				...f,
				httpStatus: null,
				latencyMs: null,
				error: (err as Error).message,
			});
		}
	}
	return out;
}
