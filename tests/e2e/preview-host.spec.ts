/**
 * Phase 26 e2e — host-driven preview reference fixture.
 *
 * Exercises the Mode A library shape end-to-end on real Cloudflare:
 * a host-owned `SiteDurableObject` (preview-host-ref) holds the
 * Workspace, Astroflare's coordinator, and the HMR endpoint.
 * globalSetup uploads `files/index.astro` via the host's
 * `/_aflare/site/file` endpoint; this spec asserts render, file
 * mutation, and 404 on missing routes.
 *
 * Self-skips when the preview-host bundle isn't built or
 * provisioning failed (no Worker Loader on free plan, etc.).
 */

import { describe, expect, it } from "vitest";
import { readRuntimeEnv } from "./runtime-env.js";

const env = readRuntimeEnv();
const describeIfPreview = env?.previewHostUrl ? describe : describe.skip;

describeIfPreview("e2e: preview-host-ref (Phase 26)", () => {
	const baseUrl = env?.previewHostUrl?.replace(/\/$/, "") ?? "";

	it("/_aflare/site/info returns the host's identity", async () => {
		const res = await fetch(`${baseUrl}/_aflare/site/info`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			site: boolean;
			workspaceInfo: { fileCount: number; totalBytes: number };
			hmrConnections: number;
		};
		expect(body.site).toBe(true);
		expect(typeof body.workspaceInfo.fileCount).toBe("number");
	});

	it("GET / renders the uploaded index.astro", async () => {
		const res = await fetch(baseUrl, { redirect: "follow" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const body = await res.text();
		// fixture's frontmatter: greeting = "Hello from the host-driven preview"
		expect(body).toContain("Hello from the host-driven preview");
	});

	it("returns 404 for an un-uploaded route", async () => {
		const res = await fetch(`${baseUrl}/this-was-never-uploaded`);
		expect(res.status).toBe(404);
	});

	it("rejects unauthenticated /_aflare/site/file writes", async () => {
		const res = await fetch(`${baseUrl}/_aflare/site/file?path=/src/pages/intruder.astro`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: new TextEncoder().encode("---\n---\n<p>nope</p>"),
		});
		expect(res.status).toBe(401);
	});

	it("authenticated write + re-fetch surfaces new content", async () => {
		const token = env?.previewHostDeployToken;
		if (!token) {
			throw new Error("previewHostDeployToken missing — globalSetup didn't seed it");
		}
		const newSource = "---\nconst greeting = 'Updated via test write';\n---\n<h1>{greeting}</h1>";
		const writeRes = await fetch(`${baseUrl}/_aflare/site/file?path=/src/pages/index.astro`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"content-type": "application/octet-stream",
			},
			body: new TextEncoder().encode(newSource),
		});
		expect(writeRes.status).toBe(200);
		const writeJson = (await writeRes.json()) as { hash: string };
		expect(writeJson.hash).toMatch(/^[0-9a-f]{64}$/);

		const refetch = await fetch(baseUrl, { redirect: "follow" });
		expect(refetch.status).toBe(200);
		const refetched = await refetch.text();
		expect(refetched).toContain("Updated via test write");
	});
});
