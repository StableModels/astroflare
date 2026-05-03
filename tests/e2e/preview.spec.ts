/**
 * Phase 25 — preview-worker e2e (Mode A: in-Worker compile +
 * render).
 *
 * Counterpart to `stack.spec.ts` / `minimal.spec.ts` (Mode B,
 * pre-rendered HTML served from R2). Where Mode B's framework code
 * runs locally during globalSetup and the stack worker is a slim
 * static server, Mode A's framework code runs *inside Cloudflare*
 * — the preview worker reads .astro source from R2, compiles it
 * via `compileAstro(skipTsTransform: true)`, spawns a child
 * isolate via the Worker Loader binding, and renders.
 *
 * The fixture's source tree is pushed to the preview workspace by
 * globalSetup via `uploadFiles` (`POST /_aflare/file`). Subsequent
 * GET requests resolve the URL pathname to a workspace path
 * (`/` → `/src/pages/index.astro`), compile, render, return HTML.
 *
 * What this exercises end-to-end:
 *   - Preview-worker provisioning + Worker Loader binding wiring
 *   - File upload + R2 write + content-addressed hash response
 *   - URL resolution + R2 source read inside the worker
 *   - `compileAstro` running inside a Cloudflare worker
 *   - Worker Loader spawning a child isolate with the runtime
 *     modules + compiled component + render shim
 *   - JSON-marshalled `RenderResult` crossing the parent/child
 *     boundary intact
 *   - HTML response surfacing back to the client
 *
 * Carry-overs (Phase 25b/25c):
 *   - HMR roundtrip over the WebSocket transport
 *   - Multi-fixture preview support (path prefixing)
 *   - DO-backed Storage backend
 */

import { describe, expect, it } from "vitest";
import { readRuntimeEnv } from "./runtime-env.js";

const env = readRuntimeEnv();
// Run only when globalSetup wrote runtime env — i.e. when CLOUDFLARE_*
// credentials were present and provisioning succeeded. Local runs
// without creds skip the whole project.
const describeIfE2e = env ? describe : describe.skip;

describeIfE2e("e2e: preview worker (Phase 25, Mode A)", () => {
	it("/_aflare/preview/info returns the preview worker's identity", async () => {
		const url = `${env?.previewUrl.replace(/\/$/, "")}/_aflare/preview/info`;
		const res = await fetch(url);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { previewWorker: boolean; workspaceId: string };
		expect(body.previewWorker).toBe(true);
		expect(body.workspaceId).toBe("default");
	});

	it("compiles + renders the uploaded fixture's index page on Cloudflare", async () => {
		const url = env?.previewUrl.replace(/\/$/, "");
		const res = await fetch(`${url}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/html/);
		const html = await res.text();
		// The minimal fixture's frontmatter sets `greeting = "Hello, edge"`
		// and the body is `<h1>{greeting}</h1>`. After in-Worker compile
		// + render, the interpolation should be in the response.
		expect(html).toContain("Hello, edge");
		expect(html).toContain("<h1");
	});

	it("returns 404 for routes whose source is not in the workspace", async () => {
		const url = env?.previewUrl.replace(/\/$/, "");
		const res = await fetch(`${url}/this-route-doesnt-exist`);
		expect(res.status).toBe(404);
	});

	it("rejects /_aflare/file writes without the deploy token", async () => {
		const url = env?.previewUrl.replace(/\/$/, "");
		const res = await fetch(`${url}/_aflare/file?path=/src/pages/index.astro`, {
			method: "POST",
			body: "ignored",
		});
		expect(res.status).toBe(401);
	});

	it("accepts /_aflare/file writes with the deploy token and returns a hash", async () => {
		const url = env?.previewUrl.replace(/\/$/, "");
		const token = env?.previewDeployToken;
		expect(token).toBeTruthy();
		// Write a no-op marker file outside the routes namespace so we
		// don't disturb the index that other specs read. The endpoint
		// returns the file's content hash; we assert structural shape.
		const path = "/src/_smoke.txt";
		const res = await fetch(`${url}/_aflare/file?path=${encodeURIComponent(path)}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"content-type": "application/octet-stream",
			},
			body: `marker-${Date.now()}`,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { path: string; size: number; hash: string };
		expect(body.path).toBe(path);
		expect(body.size).toBeGreaterThan(0);
		expect(body.hash).toMatch(/^[a-f0-9]{16,}$/);
	});

	it("re-renders the index after a source rewrite (poor-man's HMR)", async () => {
		// Write a fresh index with a unique sentinel, then read it back
		// rendered. This proves the storage layer + compile path are
		// reading R2 fresh per request, not caching across writes —
		// which is the foundation HMR needs (the actual WebSocket fan-out
		// is Phase 25b carry-over).
		const url = env?.previewUrl.replace(/\/$/, "");
		const token = env?.previewDeployToken;
		const sentinel = `aflare-edge-${Date.now()}`;
		const newSource = [
			"---",
			`const greeting = "${sentinel}";`,
			"---",
			"<html><body><h1>{greeting}</h1></body></html>",
			"",
		].join("\n");

		const writeRes = await fetch(
			`${url}/_aflare/file?path=${encodeURIComponent("/src/pages/index.astro")}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"content-type": "application/octet-stream",
				},
				body: newSource,
			},
		);
		expect(writeRes.status).toBe(200);

		const renderRes = await fetch(`${url}/`, { cache: "no-store" });
		expect(renderRes.status).toBe(200);
		const html = await renderRes.text();
		expect(html).toContain(sentinel);
	});
});
