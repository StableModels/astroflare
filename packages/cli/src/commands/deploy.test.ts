import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdDeploy, cmdRollback, cmdStatus, resolveConfig, walkProjectFiles } from "./deploy.js";
import type { DeployConfig } from "./deploy.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "aflare-cli-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function seedFile(rel: string, contents: string): void {
	const full = join(dir, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, contents);
}

describe("resolveConfig", () => {
	it("merges flags > env > config file", async () => {
		seedFile(
			"astro.config.json",
			JSON.stringify({
				accountId: "from-file",
				bucket: "from-file",
				apiToken: "from-file",
				url: "https://from-file/",
				deployToken: "from-file",
			}),
		);
		const cfg = await resolveConfig({
			flags: { projectDir: dir, accountId: "from-flag" },
			env: { CLOUDFLARE_API_TOKEN: "from-env" },
		});
		expect(cfg.accountId).toBe("from-flag");
		expect(cfg.apiToken).toBe("from-env");
		expect(cfg.bucket).toBe("from-file");
		// Trailing slash trimmed.
		expect(cfg.url).toBe("https://from-file");
	});

	it("throws when required fields are absent", async () => {
		await expect(resolveConfig({ flags: { projectDir: dir }, env: {} })).rejects.toThrow(
			/missing config/,
		);
	});
});

describe("walkProjectFiles", () => {
	it("walks src/ and public/, hashes each file, skips dot-files", async () => {
		seedFile("src/pages/index.astro", "<p>x</p>");
		seedFile("src/pages/about.md", "# About");
		seedFile("public/logo.png", "PNGBYTES");
		seedFile(".env", "ignored");
		seedFile("src/.hidden.astro", "ignored");
		seedFile("README.md", "ignored");

		const files = await walkProjectFiles(dir);
		const paths = files.map((f) => f.path).sort();
		expect(paths).toEqual(["/public/logo.png", "/src/pages/about.md", "/src/pages/index.astro"]);
		for (const f of files) {
			expect(f.hash).toMatch(/^[a-f0-9]{64}$/);
			expect(f.size).toBeGreaterThan(0);
		}
	});

	it("returns empty when src/ and public/ both missing", async () => {
		expect(await walkProjectFiles(dir)).toEqual([]);
	});
});

const CFG: DeployConfig = {
	accountId: "acct-1",
	bucket: "test-bucket",
	apiToken: "api-tok",
	url: "https://example.workers.dev",
	deployToken: "deploy-tok",
	projectDir: "",
};

describe("cmdDeploy: pipeline", () => {
	it("walks files, uploads new ones, skips matching hashes, posts to /_aflare/deploy", async () => {
		seedFile("src/pages/index.astro", "<p>v1</p>");
		seedFile("src/pages/about.md", "# About\n");

		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : (input as URL).toString();
			const method = (init?.method ?? "GET").toUpperCase();
			if (url.includes("/r2/buckets/") && method === "HEAD") {
				return new Response(null, { status: 404 });
			}
			if (url.includes("/r2/buckets/") && method === "PUT") {
				return new Response(null, { status: 200 });
			}
			if (url.endsWith("/_aflare/deploy") && method === "POST") {
				return new Response(
					JSON.stringify({
						deployHash: "abc123",
						routeCount: 2,
						skippedCount: 0,
						durationMs: 42,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			throw new Error(`unhandled fetch: ${method} ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await cmdDeploy({ ...CFG, projectDir: dir });
			expect(result.uploaded.sort()).toEqual(["/src/pages/about.md", "/src/pages/index.astro"]);
			expect(result.skipped).toEqual([]);
			expect(result.deployHash).toBe("abc123");
			expect(result.routeCount).toBe(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("skips uploads when the R2 hash matches", async () => {
		seedFile("src/pages/index.astro", "<p>same</p>");
		const files = await walkProjectFiles(dir);
		const knownHash = files[0]?.hash;
		expect(knownHash).toBeDefined();

		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : (input as URL).toString();
			const method = (init?.method ?? "GET").toUpperCase();
			if (url.includes("/r2/buckets/") && method === "HEAD") {
				return new Response(null, {
					status: 200,
					headers: { "x-amz-meta-aflare-sha": knownHash as string },
				});
			}
			if (url.endsWith("/_aflare/deploy") && method === "POST") {
				return new Response(
					JSON.stringify({
						deployHash: "h",
						routeCount: 1,
						skippedCount: 0,
						durationMs: 1,
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unhandled fetch: ${method} ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await cmdDeploy({ ...CFG, projectDir: dir });
			expect(result.uploaded).toEqual([]);
			expect(result.skipped).toEqual(["/src/pages/index.astro"]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("cmdStatus", () => {
	it("returns the worker's status payload", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ deployHash: "h1", active: true }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await cmdStatus(CFG);
			expect(result).toEqual({ deployHash: "h1", active: true });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("cmdRollback", () => {
	it("PUTs the hash bytes to /site/current", async () => {
		let bodyBytes: string | null = null;
		const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
			const body = init?.body;
			bodyBytes = body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body);
			return new Response(null, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await cmdRollback(CFG, "old-hash");
			expect(result.deployHash).toBe("old-hash");
			expect(bodyBytes).toBe("old-hash");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
