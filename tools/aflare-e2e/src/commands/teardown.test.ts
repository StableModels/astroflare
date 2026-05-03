import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "../api.js";
import { readFixtureState } from "../state.js";
import { provisionFixture } from "./provision.js";
import { teardownFixture } from "./teardown.js";

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
	rootDir = mkdtempSync(join(tmpdir(), "aflare-e2e-tear-"));
});
afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

describe("teardownFixture", () => {
	it("deletes worker + bucket and removes state", async () => {
		const client = makeMockClient();
		await provisionFixture({ rootDir, sha7: "s", fixture: "f", client, workerBundle: "x" });
		const r = await teardownFixture({ rootDir, sha7: "s", fixture: "f", client });
		expect(r.deletedWorker).toBe("aflare-e2e-f-s");
		expect(r.deletedBucket).toBe("aflare-e2e-f-s-store");
		expect(readFixtureState(rootDir, "s", "f")).toBeNull();
	});

	it("missing state file → returns nulls (already torn down)", async () => {
		const client = makeMockClient();
		const r = await teardownFixture({ rootDir, sha7: "s", fixture: "never-was", client });
		expect(r).toEqual({ deletedWorker: null, deletedBucket: null });
		expect(client.deleteWorker).not.toHaveBeenCalled();
	});

	it("partial-failure still removes state and rethrows", async () => {
		const client = makeMockClient({
			deleteWorker: vi.fn(async () => {
				throw new Error("network down");
			}),
		});
		await provisionFixture({ rootDir, sha7: "s", fixture: "f", client, workerBundle: "x" });
		await expect(teardownFixture({ rootDir, sha7: "s", fixture: "f", client })).rejects.toThrow(
			/partial teardown.*network down/,
		);
		expect(readFixtureState(rootDir, "s", "f")).toBeNull();
	});
});
