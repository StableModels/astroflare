/**
 * `af snapshot diff <hashA> <hashB>` — structural diff between two
 * snapshots in a stack's R2 bucket. Phase 26c.
 *
 * Each snapshot's `_meta.json` carries `{ entries: { <key>:
 * { contentType, hash } } }`; the diff is over the union of keys with
 * three classes:
 *   - added:   in B, not in A
 *   - removed: in A, not in B
 *   - changed: in both, hash differs
 */

import type { CloudflareClient } from "../api.js";
import { AstroflareCliError, CLI_ERROR_CODES } from "../errors.js";

export interface SnapshotDiffInput {
	client: CloudflareClient;
	bucket: string;
	prefix?: string;
	hashA: string;
	hashB: string;
}

export interface SnapshotDiffResult {
	added: readonly string[];
	removed: readonly string[];
	changed: readonly {
		route: string;
		oldHash: string;
		newHash: string;
	}[];
}

interface SnapshotMeta {
	entries: Record<string, { contentType: string; hash: string }>;
}

function normalizePrefix(p: string | undefined): string {
	if (!p) return "";
	return p.endsWith("/") ? p : `${p}/`;
}

async function readMeta(
	client: CloudflareClient,
	bucket: string,
	prefix: string,
	hash: string,
): Promise<SnapshotMeta> {
	const obj = await client.getR2Object({
		bucket,
		key: `${prefix}${hash}/_meta.json`,
	});
	if (!obj) {
		throw new AstroflareCliError(
			CLI_ERROR_CODES.R2_OBJECT_MISSING,
			`snapshot _meta.json missing for ${hash}`,
			{ bucket, hash, prefix },
		);
	}
	return JSON.parse(obj.text) as SnapshotMeta;
}

export async function snapshotDiff(input: SnapshotDiffInput): Promise<SnapshotDiffResult> {
	const prefix = normalizePrefix(input.prefix);
	const [a, b] = await Promise.all([
		readMeta(input.client, input.bucket, prefix, input.hashA),
		readMeta(input.client, input.bucket, prefix, input.hashB),
	]);
	const aKeys = new Set(Object.keys(a.entries));
	const bKeys = new Set(Object.keys(b.entries));

	const added: string[] = [];
	const removed: string[] = [];
	const changed: { route: string; oldHash: string; newHash: string }[] = [];

	for (const k of bKeys) {
		if (!aKeys.has(k)) added.push(k);
	}
	for (const k of aKeys) {
		if (!bKeys.has(k)) removed.push(k);
	}
	for (const k of aKeys) {
		if (!bKeys.has(k)) continue;
		const aEntry = a.entries[k];
		const bEntry = b.entries[k];
		if (aEntry && bEntry && aEntry.hash !== bEntry.hash) {
			changed.push({ route: k, oldHash: aEntry.hash, newHash: bEntry.hash });
		}
	}

	return {
		added: added.sort(),
		removed: removed.sort(),
		changed: changed.sort((x, y) => x.route.localeCompare(y.route)),
	};
}
