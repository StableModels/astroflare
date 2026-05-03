import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "../api.js";
import { readFixtureState } from "../state.js";
import { provisionFixture } from "./provision.js";

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
	rootDir = mkdtempSync(join(tmpdir(), "aflare-prov-"));
});
afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

describe("provisionFixture", () => {
	it("creates the bucket, uploads the worker, enables subdomain, writes state", async () => {
		const client = makeMockClient();
		const state = await provisionFixture({
			rootDir,
			sha7: "abc1234",
			fixture: "minimal",
			client,
			workerBundle: "export default {};",
		});
		expect(client.createR2Bucket).toHaveBeenCalledWith("aflare-minimal-abc1234-store");
		expect(client.uploadWorker).toHaveBeenCalledWith(
			"aflare-minimal-abc1234",
			"export default {};",
		);
		expect(client.enableWorkerSubdomain).toHaveBeenCalledWith("aflare-minimal-abc1234");
		expect(state.url).toBe("https://aflare-minimal-abc1234.test-account.workers.dev");
		expect(readFixtureState(rootDir, "abc1234", "minimal")?.workerName).toBe(state.workerName);
	});

	it("is idempotent — second call returns existing state without re-creating", async () => {
		const client = makeMockClient();
		await provisionFixture({ rootDir, sha7: "s", fixture: "f", client, workerBundle: "x" });
		await provisionFixture({ rootDir, sha7: "s", fixture: "f", client, workerBundle: "x" });
		expect(client.createR2Bucket).toHaveBeenCalledTimes(1);
		expect(client.uploadWorker).toHaveBeenCalledTimes(1);
	});

	it("force: true re-runs even when state exists", async () => {
		const client = makeMockClient();
		await provisionFixture({ rootDir, sha7: "s", fixture: "f", client, workerBundle: "x" });
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

	it("urlPattern override skips the live subdomain lookup", async () => {
		const client = makeMockClient();
		const state = await provisionFixture({
			rootDir,
			sha7: "s",
			fixture: "f",
			client,
			workerBundle: "x",
			urlPattern: (n) => `https://stub/${n}`,
		});
		expect(state.url).toBe("https://stub/aflare-f-s");
		expect(client.getAccountSubdomain).not.toHaveBeenCalled();
	});
});
