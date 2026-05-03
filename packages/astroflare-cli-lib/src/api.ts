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

/** Binding shapes Cloudflare's REST API accepts for `metadata.bindings`. */
export type WorkerBinding =
	| { type: "r2_bucket"; name: string; bucket_name: string }
	| { type: "durable_object_namespace"; name: string; class_name: string }
	| { type: "secret_text"; name: string; text: string }
	| { type: "plain_text"; name: string; text: string };

export interface UploadWorkerWithBindingsInput {
	name: string;
	body: string | ArrayBuffer;
	bindings: readonly WorkerBinding[];
	/**
	 * First-deploy DO migrations. `null` means no migration block sent.
	 * Free-plan accounts need `new_sqlite_classes`; paid plans accept
	 * either `new_classes` (legacy DurableObjectStorage) or
	 * `new_sqlite_classes` (the modern shape — what the framework's
	 * sqlite-backed Coordinator + Hibernating WS DOs assume anyway).
	 * Default to sqlite.
	 */
	migrations?: { new_classes?: readonly string[]; new_sqlite_classes?: readonly string[] } | null;
}

export interface CloudflareClient {
	/** PUT a Worker script. `body` is the bundle (text or arraybuffer). */
	uploadWorker(name: string, body: string | ArrayBuffer): Promise<void>;
	/**
	 * Upload a Worker with bindings + DO migrations. Used by
	 * `provisionStack` (which needs R2 + DO + secret bindings); the
	 * simpler `uploadWorker` covers the no-bindings code-only case.
	 */
	uploadWorkerWithBindings(input: UploadWorkerWithBindingsInput): Promise<void>;
	/** DELETE a Worker script. Idempotent — 404 is treated as success. */
	deleteWorker(name: string): Promise<void>;
	/** Create an R2 bucket. */
	createR2Bucket(name: string): Promise<void>;
	/** Delete an R2 bucket. Idempotent. */
	deleteR2Bucket(name: string): Promise<void>;
	/** List Worker scripts. */
	listWorkers(): Promise<readonly { id: string; created_on?: string }[]>;
	/**
	 * Enable the `<name>.<account>.workers.dev` URL for a Worker.
	 * Idempotent — re-enabling a Worker that's already public is a no-op.
	 */
	enableWorkerSubdomain(name: string): Promise<void>;
	/**
	 * Account-scoped workers.dev subdomain (e.g. `myteam` → Workers serve
	 * at `<name>.myteam.workers.dev`). Cached per CloudflareClient
	 * instance so a session of provision calls makes one HTTP request.
	 */
	getAccountSubdomain(): Promise<string>;
	/**
	 * PUT an object into an R2 bucket via the Cloudflare REST API. Used
	 * by `deployStaticFixture` to ship rendered HTML + the
	 * `/site/current` pointer; same shape as `cmdRollback` already uses
	 * in the CLI.
	 */
	putR2Object(input: {
		bucket: string;
		key: string;
		body: ArrayBuffer | Uint8Array | string;
		contentType?: string;
	}): Promise<void>;
	/**
	 * Delete every object in an R2 bucket (paginates through the
	 * listing if needed). Used by `destroyStack` so subsequent
	 * `deleteR2Bucket` doesn't 409 on a non-empty bucket.
	 */
	emptyR2Bucket(bucket: string): Promise<void>;
}

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";

/** Build a CloudflareClient. */
export function makeCloudflareClient(opts: CloudflareClientOptions): CloudflareClient {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
	const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
		Authorization: `Bearer ${opts.apiToken}`,
		Accept: "application/json",
		...extra,
	});
	let cachedSubdomain: string | null = null;

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
			// Modern ES-modules Workers upload: multipart/form-data carrying
			// a JSON `metadata` part declaring `main_module` plus the actual
			// module source. Passing JS as `application/javascript` would
			// instead be parsed as the legacy service-worker format and
			// reject `export default` syntax.
			await this.uploadWorkerWithBindings({ name, body, bindings: [] });
		},
		async uploadWorkerWithBindings(input) {
			const metadata: Record<string, unknown> = {
				main_module: "worker.js",
				compatibility_date: "2025-09-01",
				compatibility_flags: ["nodejs_compat"],
			};
			if (input.bindings.length > 0) metadata.bindings = input.bindings;
			if (input.migrations) metadata.migrations = input.migrations;

			const form = new FormData();
			form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
			form.append(
				"worker.js",
				new Blob([input.body], { type: "application/javascript+module" }),
				"worker.js",
			);
			await callApi("PUT", `/workers/scripts/${encodeURIComponent(input.name)}`, {
				body: form,
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
		async enableWorkerSubdomain(name) {
			await callApi("POST", `/workers/scripts/${encodeURIComponent(name)}/subdomain`, {
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled: true }),
			});
		},
		async getAccountSubdomain() {
			if (cachedSubdomain) return cachedSubdomain;
			const result = await callApi<{ subdomain?: string | null }>("GET", "/workers/subdomain");
			if (!result?.subdomain) {
				throw new Error(
					"workers.dev subdomain is not configured for this account; visit the Cloudflare dashboard and enable it under Workers & Pages → subdomain",
				);
			}
			cachedSubdomain = result.subdomain;
			return cachedSubdomain;
		},
		async putR2Object({ bucket, key, body, contentType }) {
			// R2 PUT via REST returns plain HTTP semantics (not the
			// success/result envelope), so call fetch directly rather
			// than going through `callApi`.
			const url = `${baseUrl}/accounts/${opts.accountId}/r2/buckets/${encodeURIComponent(
				bucket,
			)}/objects/${encodeURI(key)}`;
			const res = await fetchImpl(url, {
				method: "PUT",
				headers: {
					...headers(),
					"content-type": contentType ?? "application/octet-stream",
				},
				body: body as BodyInit,
			});
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`R2 PUT ${key}: ${res.status}: ${text}`);
			}
		},
		async emptyR2Bucket(bucket) {
			// Loop until a list call returns zero objects. The Cloudflare
			// listing endpoint's pagination metadata is undocumented in
			// the response shape we observe (`result_info` is sometimes
			// undefined even with more objects pending), so we trust
			// the empty-list signal instead.
			const MAX_PASSES = 10;
			for (let pass = 0; pass < MAX_PASSES; pass++) {
				const url = `${baseUrl}/accounts/${opts.accountId}/r2/buckets/${encodeURIComponent(
					bucket,
				)}/objects`;
				const res = await fetchImpl(url, { method: "GET", headers: headers() });
				if (!res.ok) {
					const text = await res.text();
					throw new Error(`R2 list ${bucket}: ${res.status}: ${text}`);
				}
				const json = (await res.json()) as {
					success?: boolean;
					errors?: unknown;
					result?: { key: string }[] | null;
				};
				if (json.success === false) {
					throw new Error(`R2 list ${bucket}: success=false: ${JSON.stringify(json.errors)}`);
				}
				const objects = json.result ?? [];
				if (objects.length === 0) return;
				for (const obj of objects) {
					const objUrl = `${baseUrl}/accounts/${opts.accountId}/r2/buckets/${encodeURIComponent(
						bucket,
					)}/objects/${encodeURI(obj.key)}`;
					const dr = await fetchImpl(objUrl, { method: "DELETE", headers: headers() });
					if (!dr.ok && dr.status !== 404) {
						const text = await dr.text();
						throw new Error(`R2 DELETE ${obj.key}: ${dr.status}: ${text}`);
					}
				}
			}
			throw new Error(
				`R2 emptyR2Bucket: bucket ${bucket} still non-empty after ${MAX_PASSES} passes`,
			);
		},
	};
}
