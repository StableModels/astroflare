#!/usr/bin/env node
/**
 * Bundle the Phase 26 reference preview host worker.
 *
 * Output: `tests/e2e/fixtures/preview-host-ref/dist/worker.bundle.js`
 *
 * Inlines `@astroflare/runtime/dist/*.js` as a JSON map under
 * `__AFLARE_RUNTIME_MODULES__`. Spawned compile/render isolates
 * resolve `import { render } from "./runtime/index.js"` against
 * this map (no separate bundling step needed inside the spawned
 * isolate).
 */

import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../..");

const ENTRY = resolve(__dirname, "src/worker.ts");
const OUT_DIR = resolve(__dirname, "dist");
const OUTFILE = resolve(OUT_DIR, "worker.bundle.js");
const RUNTIME_DIST = resolve(ROOT, "packages/runtime/dist");

mkdirSync(OUT_DIR, { recursive: true });

function loadRuntimeModules() {
	const out = {};
	for (const entry of readdirSync(RUNTIME_DIST, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
		const src = readFileSync(resolve(RUNTIME_DIST, entry.name), "utf8");
		out[`runtime/${entry.name}`] = src;
	}
	if (!("runtime/index.js" in out)) {
		throw new Error(
			"build preview-host-ref: runtime/index.js missing — run `pnpm -w build:runtime` first",
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
	// `cloudflare:workers` + `node:*` resolve in workerd at runtime
	// (`nodejs_compat` flag), so they're never bundled.
	//
	// Note: unlike deploy-host-ref, we **don't** externalise `sucrase`
	// or `style-to-js` here. The preview handler statically imports
	// `transformTS` from `@astroflare/compiler/ts` (used to strip TS
	// off `.ts`/`.tsx`/`.jsx` workspace files before module
	// substitution), and that import chain pulls sucrase into the
	// bundle. Marking it external would let the build succeed but
	// the upload would 400 with `No such module "sucrase". imported
	// from "worker.js"` — Workers can't resolve module names that
	// aren't built in. Same logic for `style-to-js` via the
	// `compileMdx` hast pipeline.
	external: [
		"cloudflare:workers",
		"node:crypto",
		"node:diagnostics_channel",
		"node:buffer",
		"node:path",
		"node:fs",
		"node:fs/promises",
		"node:os",
		"node:url",
		"node:util",
		"node:stream",
	],
	conditions: ["workerd"],
	// `platform: "neutral"` defaults to an empty `mainFields`, which
	// silently skips CJS-only deps (sucrase, style-to-js) that publish
	// `main` but not `module`/`exports`. Mirror what wrangler uses for
	// Worker bundles so the resolver can find both.
	mainFields: ["workerd", "browser", "module", "main"],
	metafile: true,
	outfile: OUTFILE,
	logLevel: "warning",
	absWorkingDir: ROOT,
	define: {
		__AFLARE_RUNTIME_MODULES__: JSON.stringify(runtimeModules),
	},
});

const size = statSync(OUTFILE).size;
console.log(`preview-host-ref bundle: ${size} bytes (${(size / 1024).toFixed(1)} KiB)`);

// The 1500-KiB ceiling pre-dated PR #7 (Shiki bundling) and PR #10
// (sucrase replacing esbuild-wasm). Preview-host runs compile +
// render in the worker, so it must inline `@astroflare/compiler` and
// its content-pipeline deps (remark / rehype / mdast / micromark /
// shiki languages + themes). Today's floor is ~11.5 MiB; the budget
// is set above it to catch accidental ballooning without forcing a
// bump on every dep churn.
const KIB_BUDGET = 14_000;
if (size > KIB_BUDGET * 1024) {
	console.error(
		`preview-host-ref bundle exceeded ${KIB_BUDGET} KiB budget — investigate before shipping`,
	);
	process.exit(1);
}

if (result.warnings.length > 0) {
	for (const w of result.warnings) console.warn(w.text);
}
