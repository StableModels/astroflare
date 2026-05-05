#!/usr/bin/env node
/**
 * Bundle the Phase 26b reference deploy host worker.
 *
 * Output: `tests/e2e/fixtures/deploy-host-ref/dist/worker.bundle.js`
 *
 * `cloudflare:workers` is left external (resolved by workerd at run
 * time). Everything else under `@astroflare/*` is bundled in. The
 * resulting bundle is what `provisionStack` uploads as the host's
 * worker bundle.
 */

import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../..");

const ENTRY = resolve(__dirname, "src/worker.ts");
const OUT_DIR = resolve(__dirname, "dist");
const OUTFILE = resolve(OUT_DIR, "worker.bundle.js");

mkdirSync(OUT_DIR, { recursive: true });

const result = await build({
	entryPoints: [ENTRY],
	bundle: true,
	format: "esm",
	platform: "neutral",
	target: "es2022",
	// `cloudflare:workers` resolves inside workerd at runtime; never bundle.
	// The other names below are reachable only through
	// `@astroflare/build`'s dynamic `import("@astroflare/compiler")`
	// chain — but deploy-host-ref serves prebuilt R2 snapshots and
	// never compiles, so those branches are dead code at runtime.
	// Marking them external stops esbuild's static analysis from
	// trying to resolve them (sucrase / style-to-js publish CJS-only
	// `main` fields that the `neutral` platform's empty `mainFields`
	// can't see, which would otherwise fail the build). This mirrors
	// how PR #10 treated `esbuild-wasm` before sucrase replaced it.
	external: ["cloudflare:workers", "sucrase", "style-to-js"],
	conditions: ["workerd"],
	metafile: true,
	outfile: OUTFILE,
	logLevel: "warning",
	absWorkingDir: ROOT,
});

const size = statSync(OUTFILE).size;
console.log(`deploy-host-ref bundle: ${size} bytes (${(size / 1024).toFixed(1)} KiB)`);

// Same envelope as the legacy stack-worker check — protects against
// the framework's snapshot adapters bloating accidentally.
const KIB_BUDGET = 5 * 1024;
if (size > KIB_BUDGET * 1024) {
	console.error(
		`deploy-host-ref bundle exceeded ${KIB_BUDGET} KiB budget — investigate before shipping`,
	);
	process.exit(1);
}

if (result.warnings.length > 0) {
	for (const w of result.warnings) console.warn(w.text);
}
