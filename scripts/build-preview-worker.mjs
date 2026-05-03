#!/usr/bin/env node
/**
 * Build the preview-worker bundle that `af provision-preview`
 * uploads to Cloudflare. Mirrors `build-stack-worker.mjs` but with
 * one extra trick: reads every compiled file under
 * `packages/astroflare-runtime/dist/` and inlines them as a JSON
 * literal under `__AFLARE_RUNTIME_MODULES__`. The preview worker
 * hands that map to spawned isolates so `import { render } from
 * "./runtime/index.js"` resolves inside the child.
 *
 * Output: `packages/astroflare-host-cloudflare/dist/preview-worker.bundle.js`
 *
 * Bundle-size budget: the preview worker fits Cloudflare's free
 * 1 MiB limit if the runtime stays small (~120 KiB) and we don't
 * accidentally pull esbuild-wasm or @astroflare/preview into the
 * parent bundle. The size cap below trips early so a regression
 * (e.g. a stray static import of `transformTS`) surfaces in CI.
 */

import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ENTRY = resolve(ROOT, "packages/astroflare-host-cloudflare/src/preview-worker.ts");
const OUT_DIR = resolve(ROOT, "packages/astroflare-host-cloudflare/dist");
const OUTFILE = resolve(OUT_DIR, "preview-worker.bundle.js");
const RUNTIME_DIST = resolve(ROOT, "packages/astroflare-runtime/dist");

mkdirSync(OUT_DIR, { recursive: true });

// Read every .js file under runtime/dist into a `runtime/<name>.js`
// keyed map. Spawned isolates resolve `./runtime/<name>.js` against
// these inlined sources.
function loadRuntimeModules() {
	const out = {};
	for (const entry of readdirSync(RUNTIME_DIST, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
		const src = readFileSync(resolve(RUNTIME_DIST, entry.name), "utf8");
		out[`runtime/${entry.name}`] = src;
	}
	if (!("runtime/index.js" in out)) {
		throw new Error(
			"build-preview-worker: runtime/index.js missing — run `pnpm -w build:runtime` first",
		);
	}
	return out;
}

const runtimeModules = loadRuntimeModules();
const runtimeBytes = Object.values(runtimeModules).reduce((n, s) => n + s.length, 0);
console.log(
	`runtime modules: ${Object.keys(runtimeModules).length} files, ${(runtimeBytes / 1024).toFixed(1)} KiB`,
);

const result = await build({
	entryPoints: [ENTRY],
	bundle: true,
	format: "esm",
	platform: "neutral",
	target: "es2022",
	// `cloudflare:workers` resolves inside workerd at runtime; never bundle.
	// `esbuild-wasm` is reachable from `compileAstro` only when
	// `skipTsTransform: false` (the dynamic `import("../ts.js")` branch in
	// `astro/index.ts`). The preview worker always passes
	// `skipTsTransform: true`, so the branch is dead at runtime — but
	// esbuild follows the dynamic import statically and fails to resolve
	// `esbuild-wasm` under `platform: "neutral"`. Marking it external
	// leaves the import as a bare specifier that workerd would only
	// resolve if the dead branch ever ran.
	external: ["cloudflare:workers", "esbuild-wasm"],
	conditions: ["workerd"],
	metafile: true,
	outfile: OUTFILE,
	logLevel: "warning",
	define: {
		__AFLARE_RUNTIME_MODULES__: JSON.stringify(runtimeModules),
	},
});

const size = statSync(OUTFILE).size;
console.log(`preview-worker bundle: ${size} bytes (${(size / 1024).toFixed(1)} KiB)`);

// Free-plan limit is 1 MiB after gzip; raw uncompressed is a generous
// proxy. 800 KiB is the budget — ~120 KiB runtime + ~50 KiB compiler
// emitter/parser + small framework code, with headroom for scope creep
// before it really matters.
const KIB_BUDGET = 800;
if (size > KIB_BUDGET * 1024) {
	console.error(
		`preview-worker bundle exceeded ${KIB_BUDGET} KiB budget — investigate before shipping`,
	);
	console.error("Top contributors:");
	const inputs = Object.entries(result.metafile.inputs)
		.map(([path, info]) => ({ path, bytes: info.bytes }))
		.sort((a, b) => b.bytes - a.bytes)
		.slice(0, 10);
	for (const { path, bytes } of inputs) {
		console.error(`  ${(bytes / 1024).toFixed(1).padStart(7)} KiB  ${path}`);
	}
	process.exit(1);
}

if (result.warnings.length > 0) {
	for (const w of result.warnings) console.warn(w.text);
}
