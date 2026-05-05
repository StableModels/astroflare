import { describe, expect, it, vi } from "vitest";
import { makeCloudflareClient } from "./api.js";

function mockResponse(status: number, body: unknown): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("makeCloudflareClient", () => {
	it("uploadWorker sends PUT as multipart/form-data with module metadata", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { success: true, result: null }));
		const client = makeCloudflareClient({
			accountId: "ACCT",
			apiToken: "TOKEN",
			fetchImpl,
			baseUrl: "https://stub",
		});
		await client.uploadWorker("my-worker", "export default {};");

		expect(fetchImpl).toHaveBeenCalledOnce();
		const call = fetchImpl.mock.calls[0];
		if (!call) throw new Error("expected call");
		const [url, init] = call;
		expect(url).toBe("https://stub/accounts/ACCT/workers/scripts/my-worker");
		expect((init as RequestInit).method).toBe("PUT");
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer TOKEN");
		// Modern ES-modules upload: body is FormData; fetch sets the
		// boundary'd content-type itself, so the wrapper doesn't pin one.
		const body = (init as RequestInit).body;
		expect(body).toBeInstanceOf(FormData);
		const fd = body as FormData;
		const metadataPart = fd.get("metadata");
		expect(metadataPart).toBeInstanceOf(Blob);
		const metadataText = await (metadataPart as Blob).text();
		const metadata = JSON.parse(metadataText) as { main_module: string };
		expect(metadata.main_module).toBe("worker.js");
		const moduleBlob = fd.get("worker.js") as Blob;
		expect(await moduleBlob.text()).toBe("export default {};");
	});

	it("enableWorkerSubdomain POSTs `{ enabled: true }` to /subdomain", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { success: true, result: null }));
		const client = makeCloudflareClient({
			accountId: "A",
			apiToken: "T",
			fetchImpl,
			baseUrl: "https://stub",
		});
		await client.enableWorkerSubdomain("my-worker");
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toBe("https://stub/accounts/A/workers/scripts/my-worker/subdomain");
		expect((init as RequestInit).method).toBe("POST");
		expect((init as RequestInit).body).toBe('{"enabled":true}');
	});

	it("getAccountSubdomain unwraps the subdomain field + caches", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(mockResponse(200, { success: true, result: { subdomain: "myteam" } }));
		const client = makeCloudflareClient({
			accountId: "A",
			apiToken: "T",
			fetchImpl,
			baseUrl: "https://stub",
		});
		expect(await client.getAccountSubdomain()).toBe("myteam");
		// Second call uses the cache → no extra fetch.
		expect(await client.getAccountSubdomain()).toBe("myteam");
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("getAccountSubdomain throws a helpful error when the account has none", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(mockResponse(200, { success: true, result: { subdomain: null } }));
		const client = makeCloudflareClient({
			accountId: "A",
			apiToken: "T",
			fetchImpl,
			baseUrl: "https://stub",
		});
		await expect(client.getAccountSubdomain()).rejects.toThrow(/workers\.dev subdomain/);
	});

	it("deleteWorker treats 404 as success", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(mockResponse(404, "not found"));
		const client = makeCloudflareClient({
			accountId: "A",
			apiToken: "T",
			fetchImpl,
			baseUrl: "https://stub",
		});
		await expect(client.deleteWorker("gone")).resolves.toBeUndefined();
	});

	it("createR2Bucket POSTs the bucket name as JSON", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, { success: true, result: null }));
		const client = makeCloudflareClient({
			accountId: "A",
			apiToken: "T",
			fetchImpl,
			baseUrl: "https://stub",
		});
		await client.createR2Bucket("my-bucket");

		const call = fetchImpl.mock.calls[0];
		if (!call) throw new Error("expected call");
		const [url, init] = call;
		expect(url).toBe("https://stub/accounts/A/r2/buckets");
		expect((init as RequestInit).method).toBe("POST");
		expect((init as RequestInit).body).toBe('{"name":"my-bucket"}');
	});

	// Adopt-existing semantics for orphan buckets. A previous run's
	// `deleteR2Bucket` can partial-fail (transient API errors) while
	// `destroyPreviewHost` / `destroyStack` still drop local state — the
	// next provision can't see the orphan via `readPreviewState` and
	// 409s on `createR2Bucket`. Treat that 409 as success when the
	// "you own it" suffix confirms the bucket is ours.
	it("createR2Bucket adopts a 409 when the bucket already belongs to us", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			mockResponse(409, {
				success: false,
				errors: [
					{
						code: 10004,
						message: "The bucket you tried to create already exists, and you own it.",
					},
				],
			}),
		);
		const client = makeCloudflareClient({
			accountId: "A",
			apiToken: "T",
			fetchImpl,
			baseUrl: "https://stub",
		});
		await expect(client.createR2Bucket("orphaned")).resolves.toBeUndefined();
	});

	it("createR2Bucket re-throws a 409 when the bucket name is taken by another account", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			mockResponse(409, {
				success: false,
				errors: [
					{
						code: 10004,
						message:
							"The bucket you tried to create already exists, and is owned by another account.",
					},
				],
			}),
		);
		const client = makeCloudflareClient({
			accountId: "A",
			apiToken: "T",
			fetchImpl,
			baseUrl: "https://stub",
		});
		await expect(client.createR2Bucket("taken")).rejects.toThrow(/another account/);
	});

	it("listWorkers returns the unwrapped result array", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			mockResponse(200, {
				success: true,
				result: [{ id: "a", created_on: "2026-01-01" }, { id: "b" }],
			}),
		);
		const client = makeCloudflareClient({
			accountId: "A",
			apiToken: "T",
			fetchImpl,
			baseUrl: "https://stub",
		});
		const out = await client.listWorkers();
		expect(out).toEqual([{ id: "a", created_on: "2026-01-01" }, { id: "b" }]);
	});

	it("non-2xx responses throw with the body included", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(mockResponse(401, "unauthorised"));
		const client = makeCloudflareClient({
			accountId: "A",
			apiToken: "T",
			fetchImpl,
			baseUrl: "https://stub",
		});
		await expect(client.uploadWorker("x", "")).rejects.toThrow(/401.*unauthorised/);
	});

	it("success=false in the JSON body throws even on 200", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			mockResponse(200, {
				success: false,
				errors: [{ code: 10001, message: "bad name" }],
			}),
		);
		const client = makeCloudflareClient({
			accountId: "A",
			apiToken: "T",
			fetchImpl,
			baseUrl: "https://stub",
		});
		await expect(client.uploadWorker("x", "")).rejects.toThrow(/success=false/);
	});
});
