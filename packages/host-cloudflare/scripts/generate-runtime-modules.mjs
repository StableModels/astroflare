#!/usr/bin/env node
/**
 * Generate `src/runtime-modules.generated.ts` — a `Record<string, string>`
 * with every `@astroflare/runtime` dist module inlined as a string literal.
 *
 * Hosts that embed `createWorkerdExecutor` need a runtime modules map so
 * spawned isolates can resolve `import { render } from "./runtime/index.js"`.
 * Pre-Phase 26-finalization, every host wired this themselves: an esbuild
 * `define` substitution for `__AFLARE_RUNTIME_MODULES__`, a custom plugin,
 * or hand-rolled string concatenation. This generator removes that work —
 * after `pnpm -w build`, hosts can `import { runtimeModules } from
 * "@astroflare/host-cloudflare/runtime-modules"` and pass it through
 * unchanged.
 *
 * Determinism contract:
 *   - keys sorted alphabetically (no Object.keys insertion-order drift)
 *   - file source text JSON-stringified (escapes are stable)
 *   - no timestamps, paths, or other run-specific bytes
 *   - no checksums shipped (a re-run with identical inputs produces
 *     identical output bytes)
 *
 * Output policy: the generated TS file IS committed to git so end-user
 * `pnpm install` works without running this script. CI checks `git diff`
 * after `pnpm build` to catch a stale checked-in file.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const RUNTIME_DIST = resolve(ROOT, "packages/runtime/dist");
const OUTFILE = resolve(__dirname, "../src/runtime-modules.generated.ts");

function loadRuntimeModules() {
	const out = {};
	for (const entry of readdirSync(RUNTIME_DIST, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
		out[`runtime/${entry.name}`] = readFileSync(resolve(RUNTIME_DIST, entry.name), "utf8");
	}
	if (!("runtime/index.js" in out)) {
		throw new Error(
			`generate-runtime-modules: runtime/index.js missing from ${RUNTIME_DIST} — run \`pnpm -w build\` first`,
		);
	}
	return out;
}

const modules = loadRuntimeModules();
const sortedKeys = Object.keys(modules).sort();

const lines = [
	"// AUTO-GENERATED — do not edit by hand. Regenerate with:",
	"//   pnpm --filter @astroflare/host-cloudflare run regen-runtime-modules",
	"// (CI checks this file is up to date with the runtime dist.)",
	"",
	"/**",
	" * Inlined sources of every `@astroflare/runtime` dist module.",
	" * Keys match the path the spawned compile/render isolate's shim",
	" * imports — `runtime/index.js`, `runtime/internal.js`, etc.",
	" *",
	" * Pass directly to `createWorkerdExecutor({ runtime: runtimeModules })`.",
	" */",
	"export const runtimeModules: Record<string, string> = {",
];

for (const key of sortedKeys) {
	lines.push(`\t${JSON.stringify(key)}: ${JSON.stringify(modules[key])},`);
}

lines.push("};");
lines.push("");

writeFileSync(OUTFILE, lines.join("\n"));

const totalBytes = sortedKeys.reduce((n, k) => n + modules[k].length, 0);
console.log(
	`generate-runtime-modules: wrote ${sortedKeys.length} files (${(totalBytes / 1024).toFixed(1)} KiB) → ${OUTFILE}`,
);
