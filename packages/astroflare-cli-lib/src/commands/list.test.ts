import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "../api.js";
import { findOrphanWorkers } from "./gc.js";
import { inspectFixture } from "./inspect.js";
import { listFixtures } from "./list.js";
import { provisionFixture } from "./provision.js";
import { statusReport } from "./status.js";

function makeMockClient(overrides: Partial<CloudflareClient> = {}): CloudflareClient {
	return {
		uploadWorker: vi.fn(async () => undefined),
		deleteWorker: vi.fn(async () => undefined),
		createR2Bucket: vi.fn(async () => undefined),
		deleteR2Bucket: vi.fn(async () => undefined),
		listWorkers: vi.fn(async () => []),
		enableWorkerSubdomain: vi.fn(async () => undefined),
		getAccountSubdomain: vi.fn(async () => "test-account"),
		putR2Object: vi.fn(async () => undefined),
		emptyR2Bucket: vi.fn(async () => undefined),
		uploadWorkerWithBindings: vi.fn(async () => undefined),
		...overrides,
	};
}

let rootDir: string;
beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), "aflare-list-"));
});
afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

describe("listFixtures", () => {
	it("returns nothing when no .state directory exists", () => {
		expect(listFixtures({ rootDir, sha7: "missing" })).toEqual([]);
	});

	it("enumerates every JSON file under the SHA's state dir", async () => {
		const client = makeMockClient();
		await provisionFixture({ rootDir, sha7: "s", fixture: "a", client, workerBundle: "x" });
		await provisionFixture({ rootDir, sha7: "s", fixture: "b", client, workerBundle: "x" });
		const out = listFixtures({ rootDir, sha7: "s" });
		expect(out.map((f) => f.fixture).sort()).toEqual(["a", "b"]);
	});
});

describe("inspectFixture", () => {
	it("returns the persisted state for a provisioned fixture", async () => {
		const client = makeMockClient();
		await provisionFixture({ rootDir, sha7: "s", fixture: "f", client, workerBundle: "x" });
		const state = inspectFixture({ rootDir, sha7: "s", fixture: "f" });
		expect(state?.workerName).toBe("aflare-f-s");
	});

	it("returns null for an unprovisioned fixture", () => {
		expect(inspectFixture({ rootDir, sha7: "s", fixture: "missing" })).toBeNull();
	});
});

describe("statusReport", () => {
	it("HEADs each fixture URL and reports status + latency", async () => {
		const client = makeMockClient();
		await provisionFixture({ rootDir, sha7: "s", fixture: "a", client, workerBundle: "x" });
		await provisionFixture({ rootDir, sha7: "s", fixture: "b", client, workerBundle: "x" });
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			return new Response("", { status: url.includes("-a-") ? 200 : 503 });
		});
		const report = await statusReport({ rootDir, sha7: "s", fetchImpl });
		expect(report).toHaveLength(2);
		const a = report.find((r) => r.fixture === "a");
		const b = report.find((r) => r.fixture === "b");
		expect(a?.httpStatus).toBe(200);
		expect(b?.httpStatus).toBe(503);
		expect(a?.latencyMs).toBeGreaterThanOrEqual(0);
		expect(a?.error).toBeNull();
	});

	it("captures fetch errors per fixture", async () => {
		const client = makeMockClient();
		await provisionFixture({ rootDir, sha7: "s", fixture: "a", client, workerBundle: "x" });
		const fetchImpl = vi.fn(async () => {
			throw new Error("ENOTFOUND");
		});
		const report = await statusReport({ rootDir, sha7: "s", fetchImpl });
		expect(report[0]?.httpStatus).toBeNull();
		expect(report[0]?.error).toContain("ENOTFOUND");
	});

	it("returns an empty list when no fixtures are provisioned", async () => {
		const report = await statusReport({ rootDir, sha7: "missing", fetchImpl: vi.fn() });
		expect(report).toEqual([]);
	});
});

describe("findOrphanWorkers", () => {
	it("identifies live workers under the e2e prefix that have no local state", async () => {
		const client = makeMockClient();
		await provisionFixture({ rootDir, sha7: "abc", fixture: "a", client, workerBundle: "x" });
		await provisionFixture({ rootDir, sha7: "abc", fixture: "b", client, workerBundle: "x" });
		const live = [
			{ id: "aflare-a-abc", created_on: "2026-01-01" },
			{ id: "aflare-b-abc", created_on: "2026-01-02" },
			{ id: "aflare-stale-zzz", created_on: "2025-12-31" },
			{ id: "unrelated-script", created_on: "2025-11-30" },
		];
		const stale = makeMockClient({ listWorkers: vi.fn(async () => live) });
		const result = await findOrphanWorkers({ rootDir, client: stale });
		expect(result.orphans).toHaveLength(1);
		expect(result.orphans[0]?.id).toBe("aflare-stale-zzz");
		expect(result.knownLocal).toContain("aflare-a-abc");
	});

	it("returns no orphans when every live worker matches local state", async () => {
		const client = makeMockClient();
		await provisionFixture({ rootDir, sha7: "x", fixture: "f", client, workerBundle: "y" });
		const stale = makeMockClient({
			listWorkers: vi.fn(async () => [{ id: "aflare-f-x" }]),
		});
		const result = await findOrphanWorkers({ rootDir, client: stale });
		expect(result.orphans).toEqual([]);
	});
});
