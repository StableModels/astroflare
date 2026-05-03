/**
 * Phase 15a deploy-pipeline tests.
 *
 * Exercises the `/_aflare/deploy` endpoint end-to-end against the real
 * R2 + DO + Worker Loader stack:
 *   - auth (missing / wrong / right token)
 *   - the ceremony (plan → render → manifest → flip /site/current)
 *   - hybrid serving (static deploy hits first; live SSR fallback for
 *     pathways the deploy didn't pre-render)
 *   - rollback / status
 */

import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const enc = (s: string) => new TextEncoder().encode(s);

async function seed(path: string, source: string): Promise<void> {
	await env.FILES.put(`files${path}`, enc(source));
}

async function wipeR2(): Promise<void> {
	let cursor: string | undefined;
	while (true) {
		const r: R2Objects = await env.FILES.list({ cursor });
		await Promise.all(r.objects.map((o) => env.FILES.delete(o.key)));
		if (!r.truncated) break;
		cursor = r.cursor;
	}
}

afterEach(async () => {
	await wipeR2();
});

const AUTH = { authorization: `Bearer ${env.DEPLOY_TOKEN}` };

describe("/_aflare/deploy: auth", () => {
	it("rejects requests without a bearer token", async () => {
		const r = await SELF.fetch("https://app/_aflare/deploy", { method: "POST" });
		expect(r.status).toBe(401);
	});

	it("rejects requests with the wrong token", async () => {
		const r = await SELF.fetch("https://app/_aflare/deploy", {
			method: "POST",
			headers: { authorization: "Bearer not-it" },
		});
		expect(r.status).toBe(401);
	});

	it("accepts requests with the right token", async () => {
		await seed("/src/pages/index.astro", "<p>v1</p>");
		const r = await SELF.fetch("https://app/_aflare/deploy", {
			method: "POST",
			headers: AUTH,
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as { deployHash: string; routeCount: number };
		expect(body.deployHash).toMatch(/^[a-f0-9]+$/);
		expect(body.routeCount).toBeGreaterThan(0);
	});
});

describe("/_aflare/deploy: ceremony", () => {
	it("renders static routes, writes a manifest, and flips /site/current", async () => {
		await seed("/src/pages/index.astro", "<p>home</p>");
		await seed("/src/pages/about.astro", "<p>about</p>");

		const deployRes = await SELF.fetch("https://app/_aflare/deploy", {
			method: "POST",
			headers: AUTH,
		});
		expect(deployRes.status).toBe(200);
		const result = (await deployRes.json()) as {
			deployHash: string;
			routeCount: number;
		};
		expect(result.routeCount).toBe(2);

		// /site/current points at the new deploy.
		const status = await SELF.fetch("https://app/_aflare/deploy/status");
		const statusBody = (await status.json()) as {
			deployHash: string | null;
			active: boolean;
		};
		expect(statusBody.deployHash).toBe(result.deployHash);
		expect(statusBody.active).toBe(true);
	});

	it("two no-op deploys produce the same deploy hash", async () => {
		await seed("/src/pages/index.astro", "<p>x</p>");
		const a = (await (
			await SELF.fetch("https://app/_aflare/deploy", { method: "POST", headers: AUTH })
		).json()) as { deployHash: string };
		const b = (await (
			await SELF.fetch("https://app/_aflare/deploy", { method: "POST", headers: AUTH })
		).json()) as { deployHash: string };
		expect(b.deployHash).toBe(a.deployHash);
	});

	it("a source change produces a different deploy hash", async () => {
		await seed("/src/pages/index.astro", "<p>v1</p>");
		const a = (await (
			await SELF.fetch("https://app/_aflare/deploy", { method: "POST", headers: AUTH })
		).json()) as { deployHash: string };

		await seed("/src/pages/index.astro", "<p>v2</p>");
		const b = (await (
			await SELF.fetch("https://app/_aflare/deploy", { method: "POST", headers: AUTH })
		).json()) as { deployHash: string };

		expect(b.deployHash).not.toBe(a.deployHash);
	});
});

describe("/_aflare/deploy: hybrid serving", () => {
	it("serves the deployed static HTML after a successful deploy", async () => {
		await seed("/src/pages/index.astro", "<p>deployed-static</p>");
		await SELF.fetch("https://app/_aflare/deploy", { method: "POST", headers: AUTH });

		const r = await SELF.fetch("https://app/");
		expect(r.status).toBe(200);
		const text = await r.text();
		expect(text).toContain("deployed-static");
		// Deployed responses don't get the HMR client injected.
		expect(text).not.toContain("data-aflare-hmr");
	});

	it("falls through to live SSR for routes not in the static deploy", async () => {
		// Deploy with one page only.
		await seed("/src/pages/index.astro", "<p>indexed</p>");
		await SELF.fetch("https://app/_aflare/deploy", { method: "POST", headers: AUTH });

		// Add a new page after the deploy. Hybrid serve falls back to
		// live SSR when the deploy artifact for `/about` is missing.
		await seed("/src/pages/about.astro", "<p>live-ssr</p>");
		const r = await SELF.fetch("https://app/about");
		expect(r.status).toBe(200);
		const body = await r.text();
		expect(body).toContain("live-ssr");
	});

	it("status endpoint returns active=false before any deploy", async () => {
		const r = await SELF.fetch("https://app/_aflare/deploy/status");
		const body = (await r.json()) as {
			deployHash: string | null;
			active: boolean;
		};
		expect(body.active).toBe(false);
		expect(body.deployHash).toBeNull();
	});
});

// `getSecret` works in code running inside the project worker isolate —
// the deploy endpoint, hybrid-serving routing, etc. User-authored
// middleware / endpoints / SSR frontmatter run inside Worker
// Loader-spawned child isolates and don't share the parent's
// `AsyncLocalStorage` context, so `getSecret` returns undefined there.
// Crossing the boundary cleanly needs threading env values through the
// JSON-marshaled task context (deferred).
//
// Unit tests for `getSecret` / `withEnvContext` live in
// `astroflare-runtime/src/env.test.ts`; the parent-worker scope is
// covered there.
