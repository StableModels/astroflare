/**
 * `aflare-e2e teardown <fixture>` — destroy the Cloudflare resources
 * for a fixture and remove the state file.
 *
 * Idempotent: 404s on either delete call are treated as success
 * (already gone). The state file is removed even if the API calls
 * fail, so re-running the teardown won't loop on a half-destroyed
 * fixture; operators get a clean slate.
 */

import type { CloudflareClient } from "../api.js";
import { deleteFixtureState, readFixtureState } from "../state.js";

export interface TeardownInput {
	rootDir: string;
	sha7: string;
	fixture: string;
	client: CloudflareClient;
}

export interface TeardownResult {
	deletedWorker: string | null;
	deletedBucket: string | null;
}

export async function teardownFixture(input: TeardownInput): Promise<TeardownResult> {
	const state = readFixtureState(input.rootDir, input.sha7, input.fixture);
	if (!state) return { deletedWorker: null, deletedBucket: null };

	let workerError: unknown = null;
	let bucketError: unknown = null;
	try {
		await input.client.deleteWorker(state.workerName);
	} catch (err) {
		workerError = err;
	}
	try {
		await input.client.deleteR2Bucket(state.bucketName);
	} catch (err) {
		bucketError = err;
	}
	deleteFixtureState(input.rootDir, input.sha7, input.fixture);

	if (workerError || bucketError) {
		const msgs: string[] = [];
		if (workerError) msgs.push(`worker: ${(workerError as Error).message}`);
		if (bucketError) msgs.push(`bucket: ${(bucketError as Error).message}`);
		throw new Error(`partial teardown: ${msgs.join("; ")}`);
	}
	return { deletedWorker: state.workerName, deletedBucket: state.bucketName };
}
