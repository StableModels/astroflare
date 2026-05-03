/**
 * `af exec <method> <path> [--body @file]` — ad-hoc Cloudflare REST
 * call (Phase 26c). For investigation when no dedicated verb fits.
 *
 * The path is appended to `https://api.cloudflare.com/client/v4`,
 * with `/accounts/<account>` already prepended (matches what
 * `CloudflareClient` does internally — keeps the surface
 * account-scoped). Auth header is auto-attached.
 *
 * Usage:
 *   af exec GET /workers/scripts/my-worker
 *   af exec POST /r2/buckets/my-bucket --body @./payload.json
 */

import { readFile } from "node:fs/promises";

export interface ExecInput {
	accountId: string;
	apiToken: string;
	method: string;
	/** Path *after* `/accounts/<id>`. */
	path: string;
	/** Body as a string or `@file:<path>` reference. */
	body?: string;
	contentType?: string;
	fetchImpl?: typeof fetch;
	baseUrl?: string;
}

export interface ExecResult {
	status: number;
	headers: Record<string, string>;
	body: string;
}

export async function exec(input: ExecInput): Promise<ExecResult> {
	const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const baseUrl = input.baseUrl ?? "https://api.cloudflare.com/client/v4";
	const url = `${baseUrl}/accounts/${input.accountId}${input.path}`;

	let body: BodyInit | undefined;
	if (input.body) {
		if (input.body.startsWith("@")) {
			const fileBytes = await readFile(input.body.slice(1));
			body = new Uint8Array(fileBytes);
		} else {
			body = input.body;
		}
	}

	const res = await fetchImpl(url, {
		method: input.method.toUpperCase(),
		headers: {
			Authorization: `Bearer ${input.apiToken}`,
			...(input.contentType ? { "content-type": input.contentType } : {}),
			Accept: "application/json",
		},
		body,
	});

	const text = await res.text();
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => {
		headers[k] = v;
	});

	return { status: res.status, headers, body: text };
}
