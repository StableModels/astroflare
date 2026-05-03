/**
 * `af health` — health check across every managed host. Issues a
 * `HEAD /` to each managed URL, collects (status, latencyMs) per
 * host. Phase 26c: now sees both legacy fixtures and stacks.
 *
 * Tests inject a `fetchImpl` mock so they don't reach the
 * network; production uses `globalThis.fetch`.
 */

import { type ManagedHost, listManaged } from "./list.js";

export interface StatusInput {
	rootDir: string;
	sha7: string;
	fetchImpl?: typeof fetch;
}

export type FixtureStatus = ManagedHost & {
	httpStatus: number | null;
	latencyMs: number | null;
	error: string | null;
};

export async function statusReport(input: StatusInput): Promise<readonly FixtureStatus[]> {
	const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const hosts = listManaged({ rootDir: input.rootDir, sha7: input.sha7 });
	const out: FixtureStatus[] = [];
	for (const f of hosts) {
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
