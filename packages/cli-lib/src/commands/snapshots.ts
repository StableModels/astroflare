/**
 * `af snapshot list / current / cat` — read-back commands for Mode B
 * deploys. Lets the agent verify what got written via the same R2
 * REST API the deploy used.
 *
 * Layout matches `R2Snapshots` (Phase 26b):
 *   <prefix><snapshotHash>/<route-key>
 *   <prefix>current
 *
 * The CLI runs from Node and talks to R2 via the Cloudflare REST API;
 * the worker-runtime `R2Snapshots` adapter and these CLI helpers share
 * no code but produce the same wire layout.
 */

import type { CloudflareClient } from "../api.js";
import { AstroflareCliError, CLI_ERROR_CODES } from "../errors.js";

export interface SnapshotListInput {
	client: CloudflareClient;
	bucket: string;
	prefix?: string;
}

export interface SnapshotInfo {
	hash: string;
	current: boolean;
}

function normalizePrefix(p: string | undefined): string {
	if (!p) return "";
	if (p.endsWith("/")) return p;
	return `${p}/`;
}

/**
 * List every snapshot hash present in the bucket under the optional
 * prefix. Marks the active one (current pointer) with `current: true`.
 */
export async function snapshotList(input: SnapshotListInput): Promise<readonly SnapshotInfo[]> {
	const prefix = normalizePrefix(input.prefix);
	const objects = await input.client.listR2Objects({ bucket: input.bucket, prefix });
	const hashes = new Set<string>();
	for (const o of objects) {
		const rel = o.key.slice(prefix.length);
		if (rel === "current") continue;
		const slash = rel.indexOf("/");
		if (slash === -1) continue;
		hashes.add(rel.slice(0, slash));
	}
	const current = await snapshotCurrent({
		client: input.client,
		bucket: input.bucket,
		prefix: input.prefix,
	});
	return Array.from(hashes)
		.sort()
		.map((hash) => ({ hash, current: hash === current }));
}

export interface SnapshotCurrentInput {
	client: CloudflareClient;
	bucket: string;
	prefix?: string;
}

/** The active snapshot hash, or `null` if no deploy yet. */
export async function snapshotCurrent(input: SnapshotCurrentInput): Promise<string | null> {
	const prefix = normalizePrefix(input.prefix);
	const obj = await input.client.getR2Object({
		bucket: input.bucket,
		key: `${prefix}current`,
	});
	if (!obj) return null;
	return obj.text.trim() || null;
}

export interface SnapshotCatInput {
	client: CloudflareClient;
	bucket: string;
	prefix?: string;
	snapshotHash: string;
	route: string;
}

export interface SnapshotCatResult {
	bytes: Uint8Array;
	contentType: string | null;
}

function routeKey(route: string): string {
	const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
	if (trimmed === "") return "index.html";
	return trimmed;
}

/**
 * Read raw bytes of one route inside one snapshot. Throws
 * `R2_OBJECT_MISSING` when not present.
 */
export async function snapshotCat(input: SnapshotCatInput): Promise<SnapshotCatResult> {
	const prefix = normalizePrefix(input.prefix);
	const key = `${prefix}${input.snapshotHash}/${routeKey(input.route)}`;
	const obj = await input.client.getR2Object({ bucket: input.bucket, key });
	if (!obj) {
		throw new AstroflareCliError(
			CLI_ERROR_CODES.R2_OBJECT_MISSING,
			`snapshot entry not found: ${input.snapshotHash}${input.route}`,
			{ bucket: input.bucket, key, snapshotHash: input.snapshotHash, route: input.route },
		);
	}
	const enc = new TextEncoder();
	const bytes = obj.text ? enc.encode(obj.text) : new Uint8Array();
	return { bytes, contentType: obj.contentType ?? null };
}
