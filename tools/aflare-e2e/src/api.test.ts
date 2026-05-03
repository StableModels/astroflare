import { describe, expect, it, vi } from "vitest";
import { makeCloudflareClient } from "./api.js";

function mockResponse(status: number, body: unknown): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("makeCloudflareClient", () => {
	it("uploadWorker sends PUT with Bearer auth + javascript content-type", async () => {
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
		expect(headers["content-type"]).toBe("application/javascript");
		expect((init as RequestInit).body).toBe("export default {};");
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
