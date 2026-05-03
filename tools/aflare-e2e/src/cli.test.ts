import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "./api.js";
import { Cli } from "./cli.js";
import { findOrphanWorkers } from "./commands/gc.js";
import { inspectFixture } from "./commands/inspect.js";
import { listFixtures } from "./commands/list.js";
import { provisionFixture } from "./commands/provision.js";
import { statusReport } from "./commands/status.js";
import { teardownFixture } from "./commands/teardown.js";
import { readFixtureState } from "./state.js";

function makeMockClient(overrides: Partial<CloudflareClient> = {}): CloudflareClient {
	return {
		uploadWorker: vi.fn(async () => undefined),
		deleteWorker: vi.fn(async () => undefined),
		createR2Bucket: vi.fn(async () => undefined),
		deleteR2Bucket: vi.fn(async () => undefined),
		listWorkers: vi.fn(async () => []),
		enableWorkerSubdomain: vi.fn(async () => undefined),
		getAccountSubdomain: vi.fn(async () => "test-account"),
		...overrides,
	};
}

let rootDir: string;
beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), "aflare-e2e-"));
});
afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

describe("provisionFixture", () => {
	it("creates a bucket + uploads worker + writes state", async () => {
		const client = makeMockClient();
		const state = await provisionFixture({
			rootDir,
			sha7: "abc1234",
			fixture: "minimal",
			client,
			workerBundle: "export default {};",
		});

		expect(client.createR2Bucket).toHaveBeenCalledWith("aflare-e2e-minimal-abc1234-store");
		expect(client.uploadWorker).toHaveBeenCalledWith(
			"aflare-e2e-minimal-abc1234",
			"export default {};",
		);
		expect(state.workerName).toBe("aflare-e2e-minimal-abc1234");
		expect(state.bucketName).toBe("aflare-e2e-minimal-abc1234-store");
		expect(state.url).toBe("https://aflare-e2e-minimal-abc1234.test-account.workers.dev");

		const persisted = readFixtureState(rootDir, "abc1234", "minimal");
		expect(persisted?.workerName).toBe(state.workerName);
	});

	it("is idempotent — second call returns existing state without re-creating", async () => {
		const client = makeMockClient();
		await provisionFixture({
			rootDir,
			sha7: "s",
			fixture: "f",
			client,
			workerBundle: "x",
		});
		await provisionFixture({
			rootDir,
			sha7: "s",
			fixture: "f",
			client,
			workerBundle: "x",
		});
		expect(client.createR2Bucket).toHaveBeenCalledTimes(1);
		expect(client.uploadWorker).toHaveBeenCalledTimes(1);
	});

	it("force: true re-runs even when state exists", async () => {
		const client = makeMockClient();
		await provisionFixture({
			rootDir,
			sha7: "s",
			fixture: "f",
			client,
			workerBundle: "x",
		});
		await provisionFixture({
			rootDir,
			sha7: "s",
			fixture: "f",
			client,
			workerBundle: "x",
			force: true,
		});
		expect(client.createR2Bucket).toHaveBeenCalledTimes(2);
	});
});

describe("teardownFixture", () => {
	it("deletes worker + bucket and removes state", async () => {
		const client = makeMockClient();
		await provisionFixture({
			rootDir,
			sha7: "s",
			fixture: "f",
			client,
			workerBundle: "x",
		});
		const r = await teardownFixture({ rootDir, sha7: "s", fixture: "f", client });
		expect(r.deletedWorker).toBe("aflare-e2e-f-s");
		expect(r.deletedBucket).toBe("aflare-e2e-f-s-store");
		expect(readFixtureState(rootDir, "s", "f")).toBeNull();
	});

	it("missing state file → returns nulls (already torn down)", async () => {
		const client = makeMockClient();
		const r = await teardownFixture({
			rootDir,
			sha7: "s",
			fixture: "never-was",
			client,
		});
		expect(r).toEqual({ deletedWorker: null, deletedBucket: null });
		expect(client.deleteWorker).not.toHaveBeenCalled();
	});

	it("partial-failure still removes state and rethrows", async () => {
		const client = makeMockClient({
			deleteWorker: vi.fn(async () => {
				throw new Error("network down");
			}),
		});
		await provisionFixture({
			rootDir,
			sha7: "s",
			fixture: "f",
			client,
			workerBundle: "x",
		});
		await expect(teardownFixture({ rootDir, sha7: "s", fixture: "f", client })).rejects.toThrow(
			/partial teardown.*network down/,
		);
		// State is still cleaned up so a re-run starts fresh.
		expect(readFixtureState(rootDir, "s", "f")).toBeNull();
	});
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

describe("Cli — argv dispatch", () => {
	function makeCli(client: CloudflareClient = makeMockClient()): {
		cli: Cli;
		log: ReturnType<typeof vi.fn>;
	} {
		const log = vi.fn();
		const cli = new Cli({
			env: {
				rootDir,
				sha7: "abc1234",
				cloudflareAccountId: "A",
				cloudflareApiToken: "T",
			},
			client,
			loadBundle: async (fixture: string) => `// stub for ${fixture}`,
			log,
		});
		return { cli, log };
	}

	it("`provision <fixture>` triggers create + upload and logs the URL", async () => {
		const client = makeMockClient();
		const { cli, log } = makeCli(client);
		const code = await cli.run(["provision", "minimal"]);
		expect(code).toBe(0);
		expect(client.uploadWorker).toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("workers.dev"));
	});

	it("`teardown <fixture>` deletes resources for an existing fixture", async () => {
		const client = makeMockClient();
		const { cli, log } = makeCli(client);
		await cli.run(["provision", "minimal"]);
		const code = await cli.run(["teardown", "minimal"]);
		expect(code).toBe(0);
		expect(client.deleteWorker).toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("destroyed"));
	});

	it("`teardown-all` walks every provisioned fixture", async () => {
		const client = makeMockClient();
		const { cli } = makeCli(client);
		await cli.run(["provision", "a"]);
		await cli.run(["provision", "b"]);
		await cli.run(["teardown-all"]);
		// Two provisions + two teardowns.
		expect(client.deleteWorker).toHaveBeenCalledTimes(2);
		expect(client.deleteR2Bucket).toHaveBeenCalledTimes(2);
	});

	it("`list` reports each provisioned fixture on its own line", async () => {
		const client = makeMockClient();
		const { cli, log } = makeCli(client);
		await cli.run(["provision", "a"]);
		await cli.run(["provision", "b"]);
		log.mockClear();
		const code = await cli.run(["list"]);
		expect(code).toBe(0);
		expect(log).toHaveBeenCalledTimes(2);
		const lines = log.mock.calls.map((c) => c[0] as string).sort();
		expect(lines[0]).toContain("a\t");
		expect(lines[1]).toContain("b\t");
	});

	it("unknown command exits 1 with usage", async () => {
		const { cli, log } = makeCli();
		const code = await cli.run(["wat"]);
		expect(code).toBe(1);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("unknown command"));
	});

	it("`provision` without a fixture name exits 1", async () => {
		const { cli, log } = makeCli();
		const code = await cli.run(["provision"]);
		expect(code).toBe(1);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("usage"));
	});
});

// ---------------------------------------------------------------------------
// Phase 20a verbs (inspect / status / gc)
// ---------------------------------------------------------------------------

describe("inspectFixture", () => {
	it("returns the persisted state for a provisioned fixture", async () => {
		const client = makeMockClient();
		await provisionFixture({
			rootDir,
			sha7: "s",
			fixture: "f",
			client,
			workerBundle: "x",
		});
		const state = inspectFixture({ rootDir, sha7: "s", fixture: "f" });
		expect(state?.workerName).toBe("aflare-e2e-f-s");
	});

	it("returns null for an unprovisioned fixture", () => {
		expect(inspectFixture({ rootDir, sha7: "s", fixture: "missing" })).toBeNull();
	});
});

describe("statusReport", () => {
	it("issues HEAD against each fixture URL and reports status + latency", async () => {
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
		// Provision two locally; the live account also has a third
		// `aflare-e2e-...` worker that nothing remembers.
		await provisionFixture({ rootDir, sha7: "abc", fixture: "a", client, workerBundle: "x" });
		await provisionFixture({ rootDir, sha7: "abc", fixture: "b", client, workerBundle: "x" });
		const live = [
			{ id: "aflare-e2e-a-abc", created_on: "2026-01-01" },
			{ id: "aflare-e2e-b-abc", created_on: "2026-01-02" },
			{ id: "aflare-e2e-stale-zzz", created_on: "2025-12-31" },
			{ id: "unrelated-script", created_on: "2025-11-30" }, // not under prefix
		];
		const stale = makeMockClient({ listWorkers: vi.fn(async () => live) });
		const result = await findOrphanWorkers({ rootDir, client: stale });
		expect(result.orphans).toHaveLength(1);
		expect(result.orphans[0]?.id).toBe("aflare-e2e-stale-zzz");
		expect(result.knownLocal).toContain("aflare-e2e-a-abc");
	});

	it("returns no orphans when every live worker matches local state", async () => {
		const client = makeMockClient();
		await provisionFixture({ rootDir, sha7: "x", fixture: "f", client, workerBundle: "y" });
		const stale = makeMockClient({
			listWorkers: vi.fn(async () => [{ id: "aflare-e2e-f-x" }]),
		});
		const result = await findOrphanWorkers({ rootDir, client: stale });
		expect(result.orphans).toEqual([]);
	});
});

describe("Cli — Phase 20a verbs", () => {
	function makeCli(client: CloudflareClient = makeMockClient()): {
		cli: Cli;
		log: ReturnType<typeof vi.fn>;
	} {
		const log = vi.fn();
		const cli = new Cli({
			env: {
				rootDir,
				sha7: "abc1234",
				cloudflareAccountId: "A",
				cloudflareApiToken: "T",
			},
			client,
			loadBundle: async (fixture: string) => `// stub for ${fixture}`,
			log,
		});
		return { cli, log };
	}

	it("`inspect <fixture>` prints state JSON for a provisioned fixture", async () => {
		const { cli, log } = makeCli();
		await cli.run(["provision", "minimal"]);
		log.mockClear();
		const code = await cli.run(["inspect", "minimal"]);
		expect(code).toBe(0);
		const json = JSON.parse(log.mock.calls[0]?.[0] as string);
		expect(json.workerName).toContain("aflare-e2e-minimal-");
	});

	it("`inspect` exits 1 with a hint when the fixture isn't provisioned", async () => {
		const { cli, log } = makeCli();
		const code = await cli.run(["inspect", "missing"]);
		expect(code).toBe(1);
		expect(log.mock.calls[0]?.[0]).toContain("no state");
	});

	it("`gc` reports orphans from the live account", async () => {
		const client = makeMockClient({
			listWorkers: vi.fn(async () => [{ id: "aflare-e2e-leaked-deadbe1" }]),
		});
		const { cli, log } = makeCli(client);
		const code = await cli.run(["gc"]);
		expect(code).toBe(0);
		const lines = log.mock.calls.map((c) => c[0] as string).join("\n");
		expect(lines).toContain("aflare-e2e-leaked-deadbe1");
		expect(lines).toContain("orphan");
	});
});
