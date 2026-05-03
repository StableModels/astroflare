/**
 * `provisionPreviewHost` — provision the Phase 26 reference Mode A
 * host (`tests/e2e/fixtures/preview-host-ref/`) on real Cloudflare.
 *
 * Bindings the host needs:
 *   - SITE_R2 (R2 bucket — Workspace spillover for >1.5MB files)
 *   - SITE_DO (Durable Object namespace → SiteDurableObject)
 *   - LOADER (Worker Loader binding for spawning compile + render isolates)
 *   - DEPLOY_TOKEN (bearer token gating /_aflare/site/file mutations)
 *
 * DO migrations register `SiteDurableObject` (the host's class —
 * exported from the host's own bundle).
 */

import { existsSync, readFileSync } from "node:fs";
import type { CloudflareClient } from "../api.js";
import {
	type PreviewState,
	deletePreviewState,
	readPreviewState,
	writePreviewState,
} from "../state.js";

export interface ProvisionPreviewHostInput {
	rootDir: string;
	sha7: string;
	name: string;
	client: CloudflareClient;
	/**
	 * Reference preview-host bundle bytes. Read from disk via
	 * `loadPreviewHostBundle` (or supplied directly for tests).
	 */
	previewHostBundle: string;
	namePattern?: (name: string, sha7: string) => string;
	urlPattern?: (workerName: string) => string;
	force?: boolean;
	deployToken?: string;
}

const DEFAULT_NAME_PATTERN = (name: string, sha7: string): string =>
	`aflare-preview-${name}-${sha7}`;

const SITE_DO_CLASS = "SiteDurableObject";

export async function provisionPreviewHost(
	input: ProvisionPreviewHostInput,
): Promise<PreviewState> {
	const namePattern = input.namePattern ?? DEFAULT_NAME_PATTERN;

	const existing = readPreviewState(input.rootDir, input.sha7, input.name);
	if (existing && !input.force) return existing;

	const workerName = namePattern(input.name, input.sha7);
	const bucketName = `${workerName}-files`;
	const deployToken = input.deployToken ?? randomDeployToken();

	await input.client.createR2Bucket(bucketName);

	const migrations = existing ? null : { new_sqlite_classes: [SITE_DO_CLASS] };

	await input.client.uploadWorkerWithBindings({
		name: workerName,
		body: input.previewHostBundle,
		bindings: [
			{ type: "r2_bucket", name: "SITE_R2", bucket_name: bucketName },
			{
				type: "durable_object_namespace",
				name: "SITE_DO",
				class_name: SITE_DO_CLASS,
			},
			{ type: "secret_text", name: "DEPLOY_TOKEN", text: deployToken },
			// Worker Loader binding — the API uses an "unsafe" type marker
			// since the binding is still gated; the Cloudflare REST surface
			// for Worker Loader uses `worker_loader` as the type.
			{ type: "worker_loader", name: "LOADER" } as never,
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

export interface DestroyPreviewHostInput {
	rootDir: string;
	sha7: string;
	name: string;
	client: CloudflareClient;
}

export interface DestroyPreviewHostResult {
	deletedWorker: string | null;
	deletedBucket: string | null;
}

export async function destroyPreviewHost(
	input: DestroyPreviewHostInput,
): Promise<DestroyPreviewHostResult> {
	const state = readPreviewState(input.rootDir, input.sha7, input.name);
	if (!state) {
		return { deletedWorker: null, deletedBucket: null };
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
		throw new Error(`partial preview-host teardown: ${msgs.join("; ")}`);
	}
	return {
		deletedWorker: state.workerName,
		deletedBucket: state.bucketName,
	};
}

/** Read the pre-built preview-host-ref bundle from disk. */
export function loadPreviewHostBundle(rootDir: string): string {
	const path = `${rootDir}/tests/e2e/fixtures/preview-host-ref/dist/worker.bundle.js`;
	if (!existsSync(path)) {
		throw new Error(
			`preview-host-ref bundle missing at ${path} — run \`node tests/e2e/fixtures/preview-host-ref/build.mjs\``,
		);
	}
	return readFileSync(path, "utf8");
}

function randomDeployToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}
