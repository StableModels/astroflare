/**
 * Phase 24 — latency acceptance against real Cloudflare.
 *
 * The brief's §11.2/3 budgets target the preview pipeline (cold +
 * warm renders, HMR roundtrip). The Phase-21 stack worker doesn't
 * run live SSR yet — it serves pre-rendered artifacts from R2 —
 * so what we measure here is closer to "static-asset latency from
 * the edge after one warm-up." We assert generous bounds so a
 * regression that doubles latency surfaces but normal Cloudflare
 * jitter doesn't flake the suite.
 *
 * Once Phase 22b/23b adds in-Worker SSR + HMR, this file grows
 * the cold-preview-p95 / HMR-roundtrip-p95 assertions the brief
 * actually calls out.
 */

import { describe, expect, it } from "vitest";
import { readRuntimeEnv } from "./runtime-env.js";

const env = readRuntimeEnv();
const describeIfE2e = env?.fixtures.includes("minimal") ? describe : describe.skip;

function p(n: number, samples: readonly number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * n) / 100));
	return sorted[idx] ?? Number.POSITIVE_INFINITY;
}

describeIfE2e("e2e: latency budgets (Phase 24)", () => {
	it("warm /_aflare/stack/info p95 < 2s over 20 requests", async () => {
		// Use the stack-info endpoint as the latency probe: it's
		// always available regardless of which deploy is current
		// (deploy-ceremony.spec.ts mutates `/site/current` and may
		// drop the minimal/basics fixtures in passing). The endpoint
		// exercises the same R2 read path the deploy-served routes
		// do, just without the route lookup.
		const url = `${env?.stackUrl.replace(/\/$/, "")}/_aflare/stack/info`;
		await fetch(url); // warm-up

		const samples: number[] = [];
		for (let i = 0; i < 20; i++) {
			const t0 = Date.now();
			const res = await fetch(url, { cache: "no-store" });
			samples.push(Date.now() - t0);
			expect(res.status).toBe(200);
		}
		const p50 = p(50, samples);
		const p95 = p(95, samples);
		console.log(
			`[latency] warm /_aflare/stack/info p50=${p50}ms p95=${p95}ms over ${samples.length} samples`,
		);
		// Generous bound — fetching workers.dev from a non-co-located
		// runner sees higher tail latency than the brief's
		// preview-pipeline budgets target. Tighten once Phase 22b lands
		// SSR-on-Cloudflare and we measure the right thing.
		expect(p95).toBeLessThan(2000);
	});

	it("404 path p95 < 2s over 10 requests", async () => {
		const baseUrl = env?.stackUrl.replace(/\/$/, "");
		await fetch(`${baseUrl}/this-is-not-a-route`);
		const samples: number[] = [];
		for (let i = 0; i < 10; i++) {
			const t0 = Date.now();
			const res = await fetch(`${baseUrl}/this-is-not-a-route`, { cache: "no-store" });
			samples.push(Date.now() - t0);
			expect(res.status).toBe(404);
		}
		const p95 = p(95, samples);
		console.log(`[latency] 404 path p95=${p95}ms over ${samples.length} samples`);
		expect(p95).toBeLessThan(2000);
	});
});
