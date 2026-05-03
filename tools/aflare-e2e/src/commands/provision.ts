/**
 * `aflare-e2e provision <fixture>` — create the Cloudflare resources
 * for a fixture and write the resulting state to
 * `tests/e2e/.state/<sha7>/<fixture>.json`.
 *
 * Resource set today: one Worker script + one R2 bucket per fixture.
 * Durable Object classes ride along inside the Worker bundle — no
 * separate API call is needed (DOs are class registrations, not
 * resources).
 *
 * Idempotent. Re-running on an already-provisioned fixture sees the
 * existing state file and short-circuits unless `force: true`.
 */

import type { CloudflareClient } from "../api.js";
import { type FixtureState, readFixtureState, writeFixtureState } from "../state.js";

export interface ProvisionInput {
	rootDir: string;
	sha7: string;
	fixture: string;
	client: CloudflareClient;
	/** Stub bundle source. The real CLI builds it from the fixture; for
	 *  unit tests, callers pass a synthetic string. */
	workerBundle: string;
	/** Pattern: `aflare-e2e-<fixture>-<sha7>`. */
	namePattern?: (fixture: string, sha7: string) => string;
	/** Default URL pattern; override for tests. */
	urlPattern?: (workerName: string) => string;
	/** Force re-provision when an existing state file is present. */
	force?: boolean;
	/**
	 * Whether the fixture needs an R2 bucket. Default `true` (matches
	 * the typical Astroflare project shape). Fixtures that don't read
	 * from R2 set this to `false` so accounts without R2 enabled can
	 * still run them.
	 */
	provisionR2?: boolean;
}

const DEFAULT_NAME_PATTERN = (fixture: string, sha7: string): string =>
	`aflare-e2e-${fixture}-${sha7}`;

export async function provisionFixture(input: ProvisionInput): Promise<FixtureState> {
	const namePattern = input.namePattern ?? DEFAULT_NAME_PATTERN;

	const existing = readFixtureState(input.rootDir, input.sha7, input.fixture);
	if (existing && !input.force) return existing;

	const workerName = namePattern(input.fixture, input.sha7);
	const provisionR2 = input.provisionR2 !== false;
	const bucketName = provisionR2 ? `${workerName}-store` : "";

	if (provisionR2) {
		await input.client.createR2Bucket(bucketName);
	}
	await input.client.uploadWorker(workerName, input.workerBundle);
	// Workers don't get a public URL by default — explicitly enable the
	// workers.dev subdomain so e2e specs can fetch the deployed Worker.
	await input.client.enableWorkerSubdomain(workerName);

	// Real workers.dev URL pattern: `<worker>.<account-subdomain>.workers.dev`.
	// Tests override `urlPattern` to a deterministic value without
	// reaching the live API.
	const url = input.urlPattern
		? input.urlPattern(workerName)
		: `https://${workerName}.${await input.client.getAccountSubdomain()}.workers.dev`;

	const state: FixtureState = {
		fixture: input.fixture,
		sha7: input.sha7,
		workerName,
		bucketName,
		url,
		provisionedAt: new Date().toISOString(),
	};
	writeFixtureState(input.rootDir, state);
	return state;
}
