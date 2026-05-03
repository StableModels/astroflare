/**
 * Materialize the starter into a `MemorySite`, run the framework's
 * preview server against each route, and assert non-error responses.
 *
 * This is the "starter actually renders" smoke test the deliverable
 * asks for. It exercises the full materialise → preview pipeline:
 *   - layout component is wired correctly
 *   - the index route renders inside the layout
 *   - the markdown route compiles + renders
 *   - the dynamic [slug] route discovers blog entries via
 *     getStaticPaths and renders the matched entry
 *
 * Uses `createTestHost()` from `@astroflare/test-utils` rather than
 * a workerd executor so this stays a fast Layer-A test.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPreviewServer } from "@astroflare/preview";
import { type TestHost, createTestHost } from "@astroflare/test-utils";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getStarterFiles } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = resolve(__dirname, "../../astroflare-runtime/dist/index.js");
const RUNTIME_URL = pathToFileURL(RUNTIME_DIST).href;

beforeAll(() => {
	if (!existsSync(RUNTIME_DIST)) {
		throw new Error(
			`Runtime dist not found at ${RUNTIME_DIST}. Run \`pnpm -w build\` before this test.`,
		);
	}
});

const active: TestHost[] = [];
afterEach(async () => {
	await Promise.all(active.splice(0).map((h) => h.dispose()));
});

function bootHost(): TestHost {
	const host = createTestHost();
	active.push(host);
	const files = getStarterFiles();
	for (const [path, bytes] of Object.entries(files)) {
		host.site.write(`/${path}`, bytes);
	}
	return host;
}

function stripHmr(html: string): string {
	return html.replace(/<script type="module">[\s\S]*?<\/script>/g, "");
}

describe("starter preview rendering", () => {
	it("renders the index page inside the layout", async () => {
		const host = bootHost();
		const server = createPreviewServer({
			config: { site: "https://example.com" },
			host,
			runtimeImport: RUNTIME_URL,
		});
		const res = await server.fetch(new Request("https://app/"));
		expect(res.status).toBe(200);
		const body = stripHmr(await res.text());
		expect(body).toContain("<title>Home</title>");
		expect(body).toContain("Welcome to your new Astroflare site");
		expect(body).toContain("built with astroflare"); // footer
	});

	it("renders the markdown about page", async () => {
		const host = bootHost();
		const server = createPreviewServer({
			config: {},
			host,
			runtimeImport: RUNTIME_URL,
		});
		const res = await server.fetch(new Request("https://app/about"));
		expect(res.status).toBe(200);
		const body = stripHmr(await res.text());
		expect(body).toContain("About this site");
	});

	it("renders the dynamic post route by slug", async () => {
		const host = bootHost();
		const server = createPreviewServer({
			config: {},
			host,
			runtimeImport: RUNTIME_URL,
		});
		const res = await server.fetch(new Request("https://app/posts/hello-world"));
		expect(res.status).toBe(200);
		const body = stripHmr(await res.text());
		expect(body).toContain("hello-world"); // slug in template
	});
});
