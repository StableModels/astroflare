/**
 * `deployStaticBundle` — multi-fixture deploy through the Phase 26b
 * snapshot pipeline. Each fixture's `src/pages/` walks via
 * `LocalSite` + `buildSite`; entries collect into a single atomic
 * snapshot; `RestR2SnapshotSink` writes them; `commit()` flips the
 * current pointer.
 *
 * The deploy hash is content-addressed over the sorted set of
 * `(route, contentHash)` pairs across all fixtures, so two no-op
 * deploys produce identical hashes.
 *
 * The wire layout is the new shape — `<snapshotHash>/<route-key>`
 * + `current`. The reference deploy host (`R2Snapshots`) reads it.
 * Replaces the legacy `files/site/<hash>/...` layout.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { LocalSite, buildSite } from "@astroflare/build";
import type { SnapshotEntry } from "@astroflare/core";
import type { CloudflareClient } from "../api.js";
import { RestR2SnapshotSink } from "../rest-snapshot-sink.js";
import type { StackState } from "../state.js";

export interface FixtureSource {
	/** Routes mount under `/<name>/...`; root index becomes `/<name>/`. */
	name: string;
	/** Local fixture root (the directory containing `src/pages/`). */
	dir: string;
}

export interface DeployStaticInput {
	stack: StackState;
	client: CloudflareClient;
	fixtures: readonly FixtureSource[];
	/** Optional prefix within the bucket (multi-site partitioning). */
	prefix?: string;
}

export interface DeployedRoute {
	fixture: string;
	route: string;
	objectKey: string;
	bytes: number;
}

export interface DeployStaticResult {
	deployHash: string;
	routes: readonly DeployedRoute[];
}

export async function deployStaticBundle(input: DeployStaticInput): Promise<DeployStaticResult> {
	if (input.fixtures.length === 0) {
		throw new Error("deployStaticBundle: no fixtures supplied");
	}

	// Build all fixtures locally, collecting SnapshotEntries.
	const all: { fixture: string; entry: SnapshotEntry }[] = [];
	for (const fixture of input.fixtures) {
		if (!existsSync(`${fixture.dir}/src/pages`)) {
			throw new Error(`fixture has no src/pages directory: ${fixture.dir}/src/pages`);
		}
		const site = new LocalSite({ dir: fixture.dir });
		for await (const entry of buildSite({ site, prefix: fixture.name })) {
			all.push({ fixture: fixture.name, entry });
		}
	}

	// Stable order for content-addressed deploy hash.
	all.sort((a, b) => a.entry.route.localeCompare(b.entry.route));
	const fingerprint = all.map((a) => `${a.entry.route}\0${a.entry.hash}`).join("\n");
	const deployHash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);

	const sink = new RestR2SnapshotSink({
		client: input.client,
		bucket: input.stack.bucketName,
		prefix: input.prefix,
	});

	const routes: DeployedRoute[] = [];
	const prefix = input.prefix ?? "";
	for (const { fixture, entry } of all) {
		await sink.put(deployHash, entry);
		const key = entry.route.replace(/^\/+/, "").replace(/\/+$/, "") || "index.html";
		routes.push({
			fixture,
			route: entry.route,
			objectKey: `${prefix}${deployHash}/${key}`,
			bytes: entry.bytes.byteLength,
		});
	}
	await sink.commit(deployHash);

	return { deployHash, routes };
}
