/**
 * Per-Worker state store — `tests/e2e/.state/<sha7>/<name>.json`.
 *
 * Provisioning a managed Worker writes a small JSON document
 * recording the resources it owns (Worker name, R2 bucket name,
 * deployed URL). Subsequent commands (`destroy`, `inspect`,
 * `health`) read that document instead of round-tripping the API.
 * Names are deterministic (`aflare-<name>-<sha7>`) so concurrent
 * runs on different SHAs share nothing.
 *
 * The directory is gitignored (`tests/e2e/.state/`) so leaked state
 * from a crashed run never lands in git; `findOrphanWorkers` sweeps
 * orphans by listing the live account.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FixtureState {
	fixture: string;
	sha7: string;
	workerName: string;
	bucketName: string;
	url: string;
	provisionedAt: string; // ISO timestamp
}

export function fixtureStatePath(rootDir: string, sha7: string, fixture: string): string {
	return `${rootDir}/tests/e2e/.state/${sha7}/${fixture}.json`;
}

export function readFixtureState(
	rootDir: string,
	sha7: string,
	fixture: string,
): FixtureState | null {
	const path = fixtureStatePath(rootDir, sha7, fixture);
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, "utf8");
	return JSON.parse(raw) as FixtureState;
}

export function writeFixtureState(rootDir: string, state: FixtureState): void {
	const path = fixtureStatePath(rootDir, state.sha7, state.fixture);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2));
}

export function deleteFixtureState(rootDir: string, sha7: string, fixture: string): void {
	const path = fixtureStatePath(rootDir, sha7, fixture);
	if (existsSync(path)) rmSync(path);
}

/**
 * Stack state — a project-worker stack with its own R2 bucket, DOs,
 * and DEPLOY_TOKEN. Distinct file extension so stacks and fixture
 * Workers can co-exist in the same `<sha7>/` directory without
 * collisions.
 */
export interface StackState {
	kind: "stack";
	name: string;
	sha7: string;
	workerName: string;
	bucketName: string;
	url: string;
	deployToken: string;
	provisionedAt: string;
}

export function stackStatePath(rootDir: string, sha7: string, name: string): string {
	return `${rootDir}/tests/e2e/.state/${sha7}/${name}.stack.json`;
}

export function readStackState(rootDir: string, sha7: string, name: string): StackState | null {
	const path = stackStatePath(rootDir, sha7, name);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as StackState;
}

export function writeStackState(rootDir: string, state: StackState): void {
	const path = stackStatePath(rootDir, state.sha7, state.name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2));
}

export function deleteStackState(rootDir: string, sha7: string, name: string): void {
	const path = stackStatePath(rootDir, sha7, name);
	if (existsSync(path)) rmSync(path);
}

/**
 * Preview-stack state — an in-Worker compile + render stack
 * (Phase 25, dual-lifecycle Mode A). Distinct from `StackState`
 * because the preview worker carries an extra Worker Loader
 * binding and its compatibility flags differ.
 */
export interface PreviewState {
	kind: "preview";
	name: string;
	sha7: string;
	workerName: string;
	bucketName: string;
	url: string;
	deployToken: string;
	provisionedAt: string;
}

export function previewStatePath(rootDir: string, sha7: string, name: string): string {
	return `${rootDir}/tests/e2e/.state/${sha7}/${name}.preview.json`;
}

export function readPreviewState(rootDir: string, sha7: string, name: string): PreviewState | null {
	const path = previewStatePath(rootDir, sha7, name);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as PreviewState;
}

export function writePreviewState(rootDir: string, state: PreviewState): void {
	const path = previewStatePath(rootDir, state.sha7, state.name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2));
}

export function deletePreviewState(rootDir: string, sha7: string, name: string): void {
	const path = previewStatePath(rootDir, sha7, name);
	if (existsSync(path)) rmSync(path);
}
