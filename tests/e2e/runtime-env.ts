/**
 * Per-run runtime environment for e2e specs.
 *
 * `globalSetup` writes a small JSON file in the test temp dir
 * (`tests/e2e/.state/<sha>/runtime.json`); specs read it. We don't
 * rely on `process.env` mutations made in globalSetup because
 * vitest's worker-pool processes are forked from the main process
 * with a snapshot of env that doesn't see post-fork mutations.
 *
 * Specs that need the live stack URL (or other per-run context)
 * call `readRuntimeEnv()`; if no run is active (no creds → no
 * setup) it returns `null` and the spec self-skips.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RuntimeEnv {
	stackUrl: string;
	deployHash: string | null;
	fixtures: readonly string[];
}

function statePath(): string {
	const sha7 = process.env.AFLARE_SHA ?? execSync("git rev-parse --short=7 HEAD").toString().trim();
	const rootDir = process.env.AFLARE_ROOT ?? process.cwd();
	return `${rootDir}/tests/e2e/.state/${sha7}/runtime.json`;
}

export function writeRuntimeEnv(env: RuntimeEnv): void {
	const path = statePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(env, null, 2));
}

export function readRuntimeEnv(): RuntimeEnv | null {
	const path = statePath();
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as RuntimeEnv;
}

/**
 * Drop any stale runtime env from a prior run. Called by
 * `globalSetup` when credentials are absent so a previous
 * credentialed run's `runtime.json` doesn't make specs target
 * URLs that have since been torn down.
 */
export function clearRuntimeEnv(): void {
	const path = statePath();
	if (existsSync(path)) {
		try {
			rmSync(path);
		} catch {
			// Best-effort — concurrent runs may race; specs still
			// self-skip when readRuntimeEnv returns malformed data.
		}
	}
}
