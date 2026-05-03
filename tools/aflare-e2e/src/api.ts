/**
 * Cloudflare REST API wrapper used by the e2e CLI.
 *
 * The interface is what `provisionFixture` / `teardownFixture` /
 * `listFixtures` need; the live implementation talks to `api.cloudflare.com/v4`,
 * the test implementation accepts a `fetch` mock so tests don't reach the
 * network. All calls are scoped by `accountId` (read from
 * `process.env.CLOUDFLARE_ACCOUNT_ID`) and authenticated by `apiToken`
 * (`process.env.CLOUDFLARE_API_TOKEN`). Both are validated by the
 * caller; the API wrapper assumes they're well-formed strings.
 *
 * The endpoint subset here is the one Phase 20 needs:
 *   - `PUT  /accounts/{aid}/workers/scripts/{name}` — upload Worker
 *   - `DELETE /accounts/{aid}/workers/scripts/{name}` — destroy Worker
 *   - `POST /accounts/{aid}/r2/buckets`              — create bucket
 *   - `DELETE /accounts/{aid}/r2/buckets/{name}`     — destroy bucket
 *   - `GET  /accounts/{aid}/workers/scripts`         — list scripts (gc / inspect)
 *
 * Results are minimally typed — Cloudflare returns JSON shaped
 * `{ result, success, errors, messages }`; the wrapper unwraps and
 * surfaces non-`success` responses as thrown errors.
 */

export interface CloudflareClientOptions {
	accountId: string;
	apiToken: string;
	/** Override `fetch` — tests inject a mock. Default `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
	/** Override the API base URL. Tests use a sentinel; production
	 *  defaults to `https://api.cloudflare.com/v4`. */
	baseUrl?: string;
}

export interface CloudflareClient {
	/** PUT a Worker script. `body` is the bundle (text or arraybuffer). */
	uploadWorker(name: string, body: string | ArrayBuffer): Promise<void>;
	/** DELETE a Worker script. Idempotent — 404 is treated as success. */
	deleteWorker(name: string): Promise<void>;
	/** Create an R2 bucket. */
	createR2Bucket(name: string): Promise<void>;
	/** Delete an R2 bucket. Idempotent. */
	deleteR2Bucket(name: string): Promise<void>;
	/** List Worker scripts. */
	listWorkers(): Promise<readonly { id: string; created_on?: string }[]>;
}

const DEFAULT_BASE = "https://api.cloudflare.com/v4";

/** Build a CloudflareClient. */
export function makeCloudflareClient(opts: CloudflareClientOptions): CloudflareClient {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
	const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
		Authorization: `Bearer ${opts.apiToken}`,
		Accept: "application/json",
		...extra,
	});

	async function callApi<T>(method: string, path: string, init: RequestInit = {}): Promise<T> {
		const url = `${baseUrl}/accounts/${opts.accountId}${path}`;
		const res = await fetchImpl(url, {
			method,
			...init,
			headers: { ...headers(), ...(init.headers ?? {}) },
		});
		if (res.status === 404 && method === "DELETE") {
			// Idempotent delete — treat as success.
			return undefined as T;
		}
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Cloudflare API ${method} ${path} → ${res.status}: ${text}`);
		}
		const json = (await res.json()) as { success?: boolean; errors?: unknown; result?: T };
		if (json.success === false) {
			throw new Error(
				`Cloudflare API ${method} ${path} returned success=false: ${JSON.stringify(json.errors)}`,
			);
		}
		return json.result as T;
	}

	return {
		async uploadWorker(name, body) {
			await callApi("PUT", `/workers/scripts/${encodeURIComponent(name)}`, {
				headers: { "content-type": "application/javascript" },
				body,
			});
		},
		async deleteWorker(name) {
			await callApi("DELETE", `/workers/scripts/${encodeURIComponent(name)}`);
		},
		async createR2Bucket(name) {
			await callApi("POST", "/r2/buckets", {
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name }),
			});
		},
		async deleteR2Bucket(name) {
			await callApi("DELETE", `/r2/buckets/${encodeURIComponent(name)}`);
		},
		async listWorkers() {
			return await callApi<readonly { id: string; created_on?: string }[]>(
				"GET",
				"/workers/scripts",
			);
		},
	};
}
