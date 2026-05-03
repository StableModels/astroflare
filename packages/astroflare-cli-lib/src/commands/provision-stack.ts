/**
 * `provisionStack` — set up an Astroflare project worker stack on
 * Cloudflare. The substrate Phase 22+ tests run against; also a
 * reference implementation users can adopt for their own infra.
 *
 * What gets created:
 *   - One R2 bucket (`<name>-store`) for project sources + deploy
 *     artifacts under `/site/<deployHash>/`.
 *   - The stack-worker bundle uploaded with bindings:
 *       - R2 binding `FILES` → the bucket above
 *       - DO binding `COORDINATOR_DO` → `CoordinatorDurableObject`
 *       - DO binding `HMR_DO` → `HmrDurableObject`
 *       - Secret `DEPLOY_TOKEN` (random per-stack)
 *     Migrations register the two DO classes on first deploy.
 *   - The workers.dev subdomain enabled so the stack is reachable.
 *
 * Idempotent. State persists to
 * `tests/e2e/.state/<sha7>/<name>.stack.json` so subsequent
 * `destroyStack` calls find what `provisionStack` created without
 * round-tripping the API.
 */

import { existsSync, readFileSync } from "node:fs";
import type { CloudflareClient } from "../api.js";
import { type StackState, deleteStackState, readStackState, writeStackState } from "../state.js";

export interface ProvisionStackInput {
	rootDir: string;
	sha7: string;
	/** Stack name. Worker is `aflare-stack-<name>-<sha7>`; bucket is `<worker>-store`. */
	name: string;
	client: CloudflareClient;
	/** Stack-worker bundle source. Read from
	 *  `packages/astroflare-host-cloudflare/dist/stack-worker.bundle.js`
	 *  by `loadStackWorkerBundle` (or supply manually for tests). */
	stackWorkerBundle: string;
	/** Pattern: `aflare-stack-<name>-<sha7>` by default. */
	namePattern?: (name: string, sha7: string) => string;
	/** Default URL pattern; override for tests. */
	urlPattern?: (workerName: string) => string;
	/** Force re-provision when an existing state file is present. */
	force?: boolean;
	/**
	 * Pre-set DEPLOY_TOKEN. When omitted, a random 32-char token is
	 * generated. Tests pin a deterministic token; production runs
	 * use the random one and read it back from the persisted state.
	 */
	deployToken?: string;
}

const DEFAULT_NAME_PATTERN = (name: string, sha7: string): string => `aflare-stack-${name}-${sha7}`;

const COORDINATOR_CLASS = "CoordinatorDurableObject";
const HMR_CLASS = "HmrDurableObject";

/**
 * Idempotent stack provisioning. Re-runs check existing state and
 * short-circuit (matches `provisionFixture`).
 */
export async function provisionStack(input: ProvisionStackInput): Promise<StackState> {
	const namePattern = input.namePattern ?? DEFAULT_NAME_PATTERN;

	const existing = readStackState(input.rootDir, input.sha7, input.name);
	if (existing && !input.force) return existing;

	const workerName = namePattern(input.name, input.sha7);
	const bucketName = `${workerName}-store`;
	const deployToken = input.deployToken ?? randomDeployToken();

	await input.client.createR2Bucket(bucketName);

	// First-deploy migrations register the DO classes. SQLite-backed
	// DOs match what the framework's Coordinator + Hibernating WS DOs
	// assume; `new_sqlite_classes` works on both free + paid plans.
	// Re-provisioning with `force: true` supplies a null migration —
	// Cloudflare treats that as a no-op when the classes already exist.
	const migrations = existing ? null : { new_sqlite_classes: [COORDINATOR_CLASS, HMR_CLASS] };

	await input.client.uploadWorkerWithBindings({
		name: workerName,
		body: input.stackWorkerBundle,
		bindings: [
			{ type: "r2_bucket", name: "FILES", bucket_name: bucketName },
			{
				type: "durable_object_namespace",
				name: "COORDINATOR_DO",
				class_name: COORDINATOR_CLASS,
			},
			{
				type: "durable_object_namespace",
				name: "HMR_DO",
				class_name: HMR_CLASS,
			},
			{ type: "secret_text", name: "DEPLOY_TOKEN", text: deployToken },
		],
		migrations,
	});
	await input.client.enableWorkerSubdomain(workerName);

	const url = input.urlPattern
		? input.urlPattern(workerName)
		: `https://${workerName}.${await input.client.getAccountSubdomain()}.workers.dev`;

	const state: StackState = {
		kind: "stack",
		name: input.name,
		sha7: input.sha7,
		workerName,
		bucketName,
		url,
		deployToken,
		provisionedAt: new Date().toISOString(),
	};
	writeStackState(input.rootDir, state);
	return state;
}

export interface DestroyStackInput {
	rootDir: string;
	sha7: string;
	name: string;
	client: CloudflareClient;
}

export interface DestroyStackResult {
	deletedWorker: string | null;
	deletedBucket: string | null;
	deletedDOs: readonly string[];
}

/**
 * Symmetric teardown — destroys the Worker (which deletes its DO
 * namespaces along with it), drops the R2 bucket, removes the local
 * state file. Idempotent: missing pieces are silently skipped.
 *
 * Note: Cloudflare's "delete worker" implicitly tears down the DO
 * namespace storage, but only after a grace period. Re-provisioning
 * with the same name during that window can fail; tests pick fresh
 * names per SHA so they never overlap.
 */
export async function destroyStack(input: DestroyStackInput): Promise<DestroyStackResult> {
	const state = readStackState(input.rootDir, input.sha7, input.name);
	if (!state) {
		return { deletedWorker: null, deletedBucket: null, deletedDOs: [] };
	}

	let workerError: unknown = null;
	let bucketError: unknown = null;
	try {
		await input.client.deleteWorker(state.workerName);
	} catch (err) {
		workerError = err;
	}
	try {
		// R2 buckets must be empty before they can be deleted. Empty
		// first; the helper paginates through the listing and deletes
		// each object until the bucket is empty (or it gives up).
		await input.client.emptyR2Bucket(state.bucketName);
		await input.client.deleteR2Bucket(state.bucketName);
	} catch (err) {
		bucketError = err;
	}
	deleteStackState(input.rootDir, input.sha7, input.name);

	if (workerError || bucketError) {
		const msgs: string[] = [];
		if (workerError) msgs.push(`worker: ${(workerError as Error).message}`);
		if (bucketError) msgs.push(`bucket: ${(bucketError as Error).message}`);
		throw new Error(`partial stack teardown: ${msgs.join("; ")}`);
	}
	return {
		deletedWorker: state.workerName,
		deletedBucket: state.bucketName,
		deletedDOs: [COORDINATOR_CLASS, HMR_CLASS],
	};
}

/** Read the pre-built stack-worker bundle from disk. */
export function loadStackWorkerBundle(rootDir: string): string {
	const path = `${rootDir}/packages/astroflare-host-cloudflare/dist/stack-worker.bundle.js`;
	if (!existsSync(path)) {
		throw new Error(
			`stack-worker bundle missing at ${path} — run \`node scripts/build-stack-worker.mjs\``,
		);
	}
	return readFileSync(path, "utf8");
}

function randomDeployToken(): string {
	// 32 chars of base64url — 192 bits of entropy. Good enough for a
	// deploy auth secret; the bearer token never leaves the project
	// owner's machine + the Worker secret.
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}
