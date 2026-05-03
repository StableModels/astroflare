/**
 * `provisionPreview` — set up a preview-worker stack on Cloudflare.
 * Mode A of the Phase 25 dual-lifecycle proof. Mirrors
 * `provisionStack` but with an extra Worker Loader binding so
 * the preview worker can spawn compile + render isolates.
 *
 * What gets created:
 *   - One R2 bucket (`<name>-store`) for the workspace files
 *     under `/files/<workspace-path>`.
 *   - The preview-worker bundle uploaded with bindings:
 *       - R2 binding `FILES` → the bucket above
 *       - DO binding `COORDINATOR_DO` → `CoordinatorDurableObject`
 *       - DO binding `HMR_DO` → `HmrDurableObject`
 *       - Worker Loader binding `LOADER`
 *       - Secret `DEPLOY_TOKEN` (random per-stack)
 *   - The workers.dev subdomain enabled.
 *
 * State persists to `tests/e2e/.state/<sha7>/<name>.preview.json`.
 */

import { existsSync, readFileSync } from "node:fs";
import type { CloudflareClient } from "../api.js";
import {
	type PreviewState,
	deletePreviewState,
	readPreviewState,
	writePreviewState,
} from "../state.js";

export interface ProvisionPreviewInput {
	rootDir: string;
	sha7: string;
	/** Preview-stack name. Worker is `aflare-preview-<name>-<sha7>`; bucket is `<worker>-store`. */
	name: string;
	client: CloudflareClient;
	/** Preview-worker bundle source. Read from
	 *  `packages/astroflare-host-cloudflare/dist/preview-worker.bundle.js`
	 *  by `loadPreviewWorkerBundle` (or supply manually for tests). */
	previewWorkerBundle: string;
	/** Pattern: `aflare-preview-<name>-<sha7>` by default. */
	namePattern?: (name: string, sha7: string) => string;
	/** Default URL pattern; override for tests. */
	urlPattern?: (workerName: string) => string;
	/** Force re-provision when an existing state file is present. */
	force?: boolean;
	/**
	 * Pre-set DEPLOY_TOKEN. When omitted, a random 32-char token is
	 * generated.
	 */
	deployToken?: string;
}

const DEFAULT_NAME_PATTERN = (name: string, sha7: string): string =>
	`aflare-preview-${name}-${sha7}`;

const COORDINATOR_CLASS = "CoordinatorDurableObject";
const HMR_CLASS = "HmrDurableObject";

/**
 * Idempotent preview-stack provisioning. Re-runs short-circuit on
 * existing state.
 */
export async function provisionPreview(input: ProvisionPreviewInput): Promise<PreviewState> {
	const namePattern = input.namePattern ?? DEFAULT_NAME_PATTERN;

	const existing = readPreviewState(input.rootDir, input.sha7, input.name);
	if (existing && !input.force) return existing;

	const workerName = namePattern(input.name, input.sha7);
	const bucketName = `${workerName}-store`;
	const deployToken = input.deployToken ?? randomDeployToken();

	await input.client.createR2Bucket(bucketName);

	const migrations = existing ? null : { new_sqlite_classes: [COORDINATOR_CLASS, HMR_CLASS] };

	await input.client.uploadWorkerWithBindings({
		name: workerName,
		body: input.previewWorkerBundle,
		bindings: [
			{ type: "r2_bucket", name: "FILES", bucket_name: bucketName },
			{ type: "durable_object_namespace", name: "COORDINATOR_DO", class_name: COORDINATOR_CLASS },
			{ type: "durable_object_namespace", name: "HMR_DO", class_name: HMR_CLASS },
			{ type: "worker_loader", name: "LOADER" },
			{ type: "secret_text", name: "DEPLOY_TOKEN", text: deployToken },
		],
		migrations,
	});
	await input.client.enableWorkerSubdomain(workerName);

	const url = input.urlPattern
		? input.urlPattern(workerName)
		: `https://${workerName}.${await input.client.getAccountSubdomain()}.workers.dev`;

	const state: PreviewState = {
		kind: "preview",
		name: input.name,
		sha7: input.sha7,
		workerName,
		bucketName,
		url,
		deployToken,
		provisionedAt: new Date().toISOString(),
	};
	writePreviewState(input.rootDir, state);
	return state;
}

export interface DestroyPreviewInput {
	rootDir: string;
	sha7: string;
	name: string;
	client: CloudflareClient;
}

export interface DestroyPreviewResult {
	deletedWorker: string | null;
	deletedBucket: string | null;
	deletedDOs: readonly string[];
}

/**
 * Symmetric teardown — destroys the Worker, empties + drops the R2
 * bucket, removes the local state file. Idempotent.
 */
export async function destroyPreview(input: DestroyPreviewInput): Promise<DestroyPreviewResult> {
	const state = readPreviewState(input.rootDir, input.sha7, input.name);
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
		await input.client.emptyR2Bucket(state.bucketName);
		await input.client.deleteR2Bucket(state.bucketName);
	} catch (err) {
		bucketError = err;
	}
	deletePreviewState(input.rootDir, input.sha7, input.name);

	if (workerError || bucketError) {
		const msgs: string[] = [];
		if (workerError) msgs.push(`worker: ${(workerError as Error).message}`);
		if (bucketError) msgs.push(`bucket: ${(bucketError as Error).message}`);
		throw new Error(`partial preview teardown: ${msgs.join("; ")}`);
	}
	return {
		deletedWorker: state.workerName,
		deletedBucket: state.bucketName,
		deletedDOs: [COORDINATOR_CLASS, HMR_CLASS],
	};
}

/** Read the pre-built preview-worker bundle from disk. */
export function loadPreviewWorkerBundle(rootDir: string): string {
	const path = `${rootDir}/packages/astroflare-host-cloudflare/dist/preview-worker.bundle.js`;
	if (!existsSync(path)) {
		throw new Error(
			`preview-worker bundle missing at ${path} — run \`node scripts/build-preview-worker.mjs\``,
		);
	}
	return readFileSync(path, "utf8");
}

function randomDeployToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}
