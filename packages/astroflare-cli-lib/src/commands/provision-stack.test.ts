import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "../api.js";
import { readStackState } from "../state.js";
import { destroyStack, provisionStack } from "./provision-stack.js";

function makeMockClient(overrides: Partial<CloudflareClient> = {}): CloudflareClient {
	return {
		uploadWorker: vi.fn(async () => undefined),
		uploadWorkerWithBindings: vi.fn(async () => undefined),
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
	rootDir = mkdtempSync(join(tmpdir(), "aflare-stack-"));
});
afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

describe("provisionStack", () => {
	it("creates the bucket, uploads the worker with bindings + DO migrations, returns state", async () => {
		const client = makeMockClient();
		const state = await provisionStack({
			rootDir,
			sha7: "abc1234",
			name: "test",
			client,
			stackWorkerBundle: "export default {}",
			deployToken: "fixed-token",
		});
		expect(client.createR2Bucket).toHaveBeenCalledWith("aflare-stack-test-abc1234-store");
		expect(client.uploadWorkerWithBindings).toHaveBeenCalledOnce();
		const uploadCall = (client.uploadWorkerWithBindings as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0];
		expect(uploadCall.name).toBe("aflare-stack-test-abc1234");
		expect(uploadCall.bindings).toContainEqual({
			type: "r2_bucket",
			name: "FILES",
			bucket_name: "aflare-stack-test-abc1234-store",
		});
		expect(uploadCall.bindings).toContainEqual({
			type: "durable_object_namespace",
			name: "COORDINATOR_DO",
			class_name: "CoordinatorDurableObject",
		});
		expect(uploadCall.bindings).toContainEqual({
			type: "durable_object_namespace",
			name: "HMR_DO",
			class_name: "HmrDurableObject",
		});
		expect(uploadCall.bindings).toContainEqual({
			type: "secret_text",
			name: "DEPLOY_TOKEN",
			text: "fixed-token",
		});
		expect(uploadCall.migrations).toEqual({
			new_sqlite_classes: ["CoordinatorDurableObject", "HmrDurableObject"],
		});
		expect(client.enableWorkerSubdomain).toHaveBeenCalledWith("aflare-stack-test-abc1234");
		expect(state.workerName).toBe("aflare-stack-test-abc1234");
		expect(state.bucketName).toBe("aflare-stack-test-abc1234-store");
		expect(state.url).toBe("https://aflare-stack-test-abc1234.test-account.workers.dev");
		expect(state.deployToken).toBe("fixed-token");
		expect(readStackState(rootDir, "abc1234", "test")).toMatchObject({
			workerName: "aflare-stack-test-abc1234",
			deployToken: "fixed-token",
		});
	});

	it("generates a random deploy token when none provided", async () => {
		const client = makeMockClient();
		const state = await provisionStack({
			rootDir,
			sha7: "s",
			name: "n",
			client,
			stackWorkerBundle: "x",
		});
		expect(state.deployToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
	});

	it("is idempotent — second call returns existing state without re-creating", async () => {
		const client = makeMockClient();
		await provisionStack({
			rootDir,
			sha7: "s",
			name: "n",
			client,
			stackWorkerBundle: "x",
			deployToken: "t",
		});
		await provisionStack({
			rootDir,
			sha7: "s",
			name: "n",
			client,
			stackWorkerBundle: "x",
			deployToken: "t",
		});
		expect(client.createR2Bucket).toHaveBeenCalledTimes(1);
		expect(client.uploadWorkerWithBindings).toHaveBeenCalledTimes(1);
	});

	it("force: true re-runs without DO migrations (already registered)", async () => {
		const client = makeMockClient();
		await provisionStack({
			rootDir,
			sha7: "s",
			name: "n",
			client,
			stackWorkerBundle: "x",
			deployToken: "t",
		});
		await provisionStack({
			rootDir,
			sha7: "s",
			name: "n",
			client,
			stackWorkerBundle: "y",
			deployToken: "t",
			force: true,
		});
		const calls = (client.uploadWorkerWithBindings as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls).toHaveLength(2);
		// First call brings new_sqlite_classes; second skips them.
		expect(calls[0]?.[0].migrations).toEqual({
			new_sqlite_classes: ["CoordinatorDurableObject", "HmrDurableObject"],
		});
		expect(calls[1]?.[0].migrations).toBeNull();
	});
});

describe("destroyStack", () => {
	it("deletes worker + bucket and removes state", async () => {
		const client = makeMockClient();
		await provisionStack({
			rootDir,
			sha7: "s",
			name: "n",
			client,
			stackWorkerBundle: "x",
			deployToken: "t",
		});
		const r = await destroyStack({ rootDir, sha7: "s", name: "n", client });
		expect(r.deletedWorker).toBe("aflare-stack-n-s");
		expect(r.deletedBucket).toBe("aflare-stack-n-s-store");
		expect(readStackState(rootDir, "s", "n")).toBeNull();
	});

	it("missing state file → returns nulls (already torn down)", async () => {
		const client = makeMockClient();
		const r = await destroyStack({ rootDir, sha7: "s", name: "missing", client });
		expect(r).toEqual({ deletedWorker: null, deletedBucket: null, deletedDOs: [] });
		expect(client.deleteWorker).not.toHaveBeenCalled();
	});

	it("partial-failure still removes state and rethrows", async () => {
		const client = makeMockClient({
			deleteWorker: vi.fn(async () => {
				throw new Error("api down");
			}),
		});
		await provisionStack({
			rootDir,
			sha7: "s",
			name: "n",
			client,
			stackWorkerBundle: "x",
			deployToken: "t",
		});
		await expect(destroyStack({ rootDir, sha7: "s", name: "n", client })).rejects.toThrow(
			/partial stack teardown.*api down/,
		);
		expect(readStackState(rootDir, "s", "n")).toBeNull();
	});
});
