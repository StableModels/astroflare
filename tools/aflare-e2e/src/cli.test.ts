import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "./api.js";
import { Cli } from "./cli.js";
import { listFixtures } from "./commands/list.js";
import { provisionFixture } from "./commands/provision.js";
import { teardownFixture } from "./commands/teardown.js";
import { readFixtureState } from "./state.js";

function makeMockClient(overrides: Partial<CloudflareClient> = {}): CloudflareClient {
	return {
		uploadWorker: vi.fn(async () => undefined),
		deleteWorker: vi.fn(async () => undefined),
		createR2Bucket: vi.fn(async () => undefined),
		deleteR2Bucket: vi.fn(async () => undefined),
		listWorkers: vi.fn(async () => []),
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
		expect(state.url).toBe("https://aflare-e2e-minimal-abc1234.workers.dev");

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
