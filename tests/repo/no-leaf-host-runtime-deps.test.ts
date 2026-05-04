/**
 * Repo-hygiene contract: no leaf workspace package may declare a dep
 * on a library the host application is likely to bundle into its own
 * runtime (`react`, `react-dom`, `vue`, `svelte`, …).
 *
 * Why this matters for embedders. Astroflare is consumed two ways:
 *   1. As published packages — `npm install @astroflare/runtime`.
 *      Leaf devDeps are inert here; npm/pnpm/Bun don't install
 *      another package's devDeps when you depend on it.
 *   2. As workspace members — a host monorepo lists
 *      `vendor/astroflare/packages/*` in its `workspaces` and consumes
 *      Astroflare as direct workspace siblings. This is how the Ember
 *      team (and any other workspace embedder) consume us today.
 *
 * In mode (2) every leaf-package dep — runtime AND dev — participates
 * in the host's resolution graph. If `packages/runtime/package.json`
 * pins `"react": "18.3.1"`, the host's package manager treats that as
 * a hard constraint at the workspace level. An exact pin on a leaf
 * package wins over wider host ranges (`^19.0.0`) and gets elevated
 * to the top-level `node_modules/react`, displacing whatever React
 * the host already had. Hosts running React ≥ 19 then see two
 * physical React copies in `node_modules` (one at top-level, one
 * nested under transitive consumers that peer-dep on `^19`), and
 * any element minted by the wrong copy throws the minified
 * `React error #525` at render time.
 *
 * The contract: every host-runtime-shaped dep lives at the workspace
 * root, where it's treated as the monorepo's own dev tooling and
 * doesn't propagate to embedders. Leaf packages must be silent on
 * those names.
 *
 * If a future leaf-package test legitimately needs one of these
 * names, prefer (in order):
 *   1. Run the test from a project (`tests/<name>/`) rather than the
 *      leaf package itself — same effect, no metadata leak.
 *   2. Bring the dep in via `@astroflare/test-utils` (which is itself
 *      a leaf and so would also need to be silent on these names —
 *      i.e. don't do this for host-runtime libraries).
 *   3. Last resort: a `peerDependencies` entry with
 *      `peerDependenciesMeta.<name>.optional: true`. Permissive enough
 *      that hosts dedupe against their own pin; explicit about the
 *      intent.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Names a host application is likely to bundle into its own runtime.
 * Anything matching here propagating from a leaf package risks a
 * dual-copy bug in the host's bundle.
 *
 * Keep this list narrow — it's a deny-list, not an allow-list. We're
 * not policing every npm package; we're stopping the specific class
 * of bug where a leaf devDep displaces a host's own runtime
 * resolution. Add a name here when (a) hosts commonly ship it in
 * their bundle, and (b) duplicate copies break at runtime (singletons
 * that hold module-level state, frameworks that use `instanceof`, etc.).
 */
const HOST_RUNTIME_NAMES = [
	"react",
	"react-dom",
	"@types/react",
	"@types/react-dom",
	"vue",
	"@vue/runtime-core",
	"@vue/runtime-dom",
	"svelte",
	"solid-js",
	"preact",
];

interface PackageJson {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

interface Offender {
	pkgPath: string;
	pkgName: string;
	depName: string;
	depKind: "dependencies" | "devDependencies" | "peerDependencies";
	specifier: string;
}

function leafPackageJsonPaths(): string[] {
	const out: string[] = [];
	const dirs = [
		path.join(REPO_ROOT, "packages"),
		path.join(REPO_ROOT, "tests"),
		path.join(REPO_ROOT, "examples"),
	];
	for (const dir of dirs) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry);
			if (!statSync(full).isDirectory()) continue;
			const pkg = path.join(full, "package.json");
			try {
				statSync(pkg);
				out.push(pkg);
			} catch {
				// no package.json — skip
			}
		}
	}
	// Reference fixtures are workspace members too.
	for (const fixture of ["preview-host-ref", "deploy-host-ref"]) {
		const pkg = path.join(REPO_ROOT, "tests", "e2e", "fixtures", fixture, "package.json");
		try {
			statSync(pkg);
			out.push(pkg);
		} catch {
			// fixture missing — skip
		}
	}
	return out;
}

describe("repo hygiene", () => {
	it("no leaf workspace package declares a host-runtime-shaped dep", () => {
		const offenders: Offender[] = [];
		for (const pkgPath of leafPackageJsonPaths()) {
			const json = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
			const buckets: Array<{
				name: "dependencies" | "devDependencies" | "peerDependencies";
				deps: Record<string, string> | undefined;
			}> = [
				{ name: "dependencies", deps: json.dependencies },
				{ name: "devDependencies", deps: json.devDependencies },
				{ name: "peerDependencies", deps: json.peerDependencies },
			];
			for (const { name: depKind, deps } of buckets) {
				if (!deps) continue;
				for (const depName of HOST_RUNTIME_NAMES) {
					if (depName in deps) {
						offenders.push({
							pkgPath: path.relative(REPO_ROOT, pkgPath),
							pkgName: json.name ?? "<unnamed>",
							depName,
							depKind,
							specifier: deps[depName] as string,
						});
					}
				}
			}
		}
		if (offenders.length > 0) {
			const lines = offenders.map(
				(o) => `  ${o.pkgPath} (${o.pkgName}): ${o.depKind}.${o.depName} = "${o.specifier}"`,
			);
			throw new Error(
				[
					"Host-runtime-shaped deps must live at the workspace root, not in leaf packages.",
					"Workspace embedders (Ember-style monorepos that vendor `packages/*` directly)",
					"see leaf devDeps as workspace-level constraints; an exact pin on `react`",
					"in a leaf package displaces the host's own React resolution and produces",
					"duplicate-React bundles (React minified error #525) at runtime.",
					"",
					"Offenders:",
					...lines,
					"",
					"Move these entries to the root `package.json`'s `devDependencies`,",
					"or — if a leaf test legitimately needs the name — run that test from",
					"`tests/<name>/` instead so the metadata stays out of the package.",
				].join("\n"),
			);
		}
		// Defensive: guard against a refactor accidentally returning an
		// empty list of packages and silently passing.
		expect(leafPackageJsonPaths().length).toBeGreaterThan(0);
	});
});
