/**
 * Repo-hygiene contract: `pnpm test` must run every vitest project.
 *
 * `pnpm test` is split into two invocations so the upstream workerd
 * teardown crash (cloudflare/workerd#6506) in the Layer-B pool can't
 * red an otherwise-green run:
 *   - `test:node`    — enumerated Node-pool projects.
 *   - `test:workerd` — the workerd-pool projects, behind the
 *                      fail-closed retry guard (`scripts/run-workerd-tests.mjs`).
 *
 * Enumeration means a newly-added project is silently skipped unless
 * someone updates one of the two lists. This test fails loudly when
 * the union of the two lists drifts from the actual workspace, keeping
 * `pnpm test` a trustworthy signal.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string): string {
	return readFileSync(resolve(repoRoot, rel), "utf8");
}

/** Project names declared across every config in the workspace. */
function workspaceProjectNames(): string[] {
	const ws = read("vitest.workspace.ts");
	const configPaths = [...ws.matchAll(/["'](\.\/[^"']+vitest\.config\.ts)["']/g)].map((m) => m[1]);
	expect(configPaths.length).toBeGreaterThan(0);
	const names: string[] = [];
	for (const p of configPaths) {
		const src = read(p);
		const m = src.match(/name:\s*["']([^"']+)["']/);
		expect(m, `no test.name in ${p}`).toBeTruthy();
		names.push((m as RegExpMatchArray)[1]);
	}
	return names;
}

function nodeListFromPackageJson(): string[] {
	const pkg = JSON.parse(read("package.json")) as {
		scripts: Record<string, string>;
	};
	const script = pkg.scripts["test:node"];
	expect(script, "missing test:node script").toBeTruthy();
	return [...script.matchAll(/--project\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

function workerdListFromGuard(): string[] {
	const src = read("scripts/run-workerd-tests.mjs");
	const block = src.match(/\[\s*((?:"[^"]+"\s*,?\s*)+)\]/);
	expect(block, "could not parse default PROJECTS from guard script").toBeTruthy();
	return [...(block as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("pnpm test covers every vitest project", () => {
	it("the union of test:node + test:workerd equals the workspace, with no overlap", () => {
		const all = new Set(workspaceProjectNames());
		const node = nodeListFromPackageJson();
		const workerd = workerdListFromGuard();

		const overlap = node.filter((n) => workerd.includes(n));
		expect(overlap, "a project is in BOTH test:node and test:workerd").toEqual([]);

		const covered = new Set([...node, ...workerd]);

		const skipped = [...all].filter((n) => !covered.has(n));
		expect(skipped, `workspace projects NOT run by pnpm test: ${skipped}`).toEqual([]);

		const phantom = [...covered].filter((n) => !all.has(n));
		expect(phantom, `pnpm test references non-existent projects: ${phantom}`).toEqual([]);
	});
});
