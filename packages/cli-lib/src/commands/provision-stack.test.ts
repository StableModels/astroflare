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
		putR2Object: vi.fn(async () => undefined),
		emptyR2Bucket: vi.fn(async () => undefined),
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
	it("creates the bucket, uploads the host worker with R2 binding + DEPLOY_TOKEN, returns state", async () => {
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
		// Phase 26b: bindings are exactly the host's needs — one R2 bucket + DEPLOY_TOKEN.
		expect(uploadCall.bindings).toContainEqual({
			type: "r2_bucket",
			name: "SITE_BUCKET",
			bucket_name: "aflare-stack-test-abc1234-store",
		});
		expect(uploadCall.bindings).toContainEqual({
			type: "secret_text",
			name: "DEPLOY_TOKEN",
			text: "fixed-token",
		});
		// Phase 26b: no Astroflare-owned DO classes — host's own DOs (if any)
		// are registered by the host's wrangler, not by `provisionStack`.
		expect(uploadCall.bindings).not.toContainEqual(
			expect.objectContaining({ type: "durable_object_namespace" }),
		);
		expect(uploadCall.migrations).toBeNull();
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

	it("force: true re-runs the upload (no migrations either way)", async () => {
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
		// Phase 26b: no DO migrations, ever.
		expect(calls[0]?.[0].migrations).toBeNull();
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
