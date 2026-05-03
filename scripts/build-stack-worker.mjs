#!/usr/bin/env node
/**
 * Build the stack-worker bundle that `af provision-stack` uploads to
 * Cloudflare. esbuild rolls everything reachable from
 * `stack-worker.ts` into one ESM file with `cloudflare:workers`
 * left external (resolved by workerd at run time).
 *
 * Output: `packages/astroflare-host-cloudflare/dist/stack-worker.bundle.js`
 */

import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ENTRY = resolve(ROOT, "packages/astroflare-host-cloudflare/src/stack-worker.ts");
const OUT_DIR = resolve(ROOT, "packages/astroflare-host-cloudflare/dist");
const OUTFILE = resolve(OUT_DIR, "stack-worker.bundle.js");

mkdirSync(OUT_DIR, { recursive: true });

const result = await build({
	entryPoints: [ENTRY],
	bundle: true,
	format: "esm",
	platform: "neutral",
	target: "es2022",
	// `cloudflare:workers` resolves inside workerd at runtime; never bundle it.
	external: ["cloudflare:workers"],
	conditions: ["workerd"],
	metafile: true,
	outfile: OUTFILE,
	logLevel: "warning",
});

const size = statSync(OUTFILE).size;
console.log(`stack-worker bundle: ${size} bytes (${(size / 1024).toFixed(1)} KiB)`);

// Cloudflare's free plan caps Workers at 1 MiB compressed — we don't
// gzip here, but raw bytes give a quick sanity check. Production
// stacks on paid plans get 10 MiB; either way, this number should
// shock anyone if the bundle balloons unexpectedly.
const KIB_BUDGET = 5 * 1024;
if (size > KIB_BUDGET * 1024) {
	console.error(
		`stack-worker bundle exceeded ${KIB_BUDGET} KiB budget — investigate before shipping`,
	);
	process.exit(1);
}

if (result.warnings.length > 0) {
	for (const w of result.warnings) console.warn(w.text);
}
