#!/usr/bin/env node
/**
 * Generate `src/starter-files.generated.ts` — every file under
 * `template/` packed as a base64 string so the package can ship the
 * scaffold to Workers-runtime consumers without `node:fs`.
 *
 * The generated map is a `Record<string, string>` of POSIX path → base64.
 * Both the programmatic `getStarterFiles()` and the on-disk
 * `writeStarterFiles()` decode from this same source so the two
 * consumption modes produce byte-identical output.
 *
 * Determinism:
 *   - paths sorted (stable insertion order in the emitted object)
 *   - base64 is deterministic
 *   - no timestamps, no checksums, no path-specific bytes
 *
 * Output policy: the generated TS file IS committed to git so end-user
 * `pnpm install` works without running this script. CI checks `git diff`
 * after `pnpm build` to catch a stale checked-in file.
 *
 * Excluded files (by name): `node_modules`, `dist`, `.wrangler`.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(__dirname, "../template");
const OUTFILE = resolve(__dirname, "../src/starter-files.generated.ts");
const SKIP = new Set(["node_modules", "dist", ".wrangler", ".DS_Store"]);

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const abs = resolve(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(abs));
		else if (entry.isFile()) out.push(abs);
	}
	return out;
}

const files = walk(TEMPLATE);
const entries = files
	.map((abs) => {
		// Use POSIX separators in the manifest so the same map works on
		// any OS the consumer runs.
		const rel = relative(TEMPLATE, abs).split(/[\\/]/).join("/");
		const bytes = readFileSync(abs);
		return { rel, b64: bytes.toString("base64") };
	})
	.sort((a, b) => a.rel.localeCompare(b.rel));

const lines = [
	"// AUTO-GENERATED — do not edit by hand. Regenerate with:",
	"//   pnpm --filter @astroflare/starter run regen-starter-files",
	"// (CI checks this file is up to date with the template/.)",
	"",
	"/**",
	" * Base64-encoded source bytes of every file under `template/`.",
	" * Keys are POSIX-style relative paths (no leading `/`).",
	" * Decoded by `getStarterFiles()` (programmatic) and",
	" * `writeStarterFiles()` (on-disk).",
	" */",
	"export const STARTER_FILES_BASE64: Record<string, string> = {",
];

for (const { rel, b64 } of entries) {
	lines.push(`\t${JSON.stringify(rel)}: ${JSON.stringify(b64)},`);
}

lines.push("};");
lines.push("");

writeFileSync(OUTFILE, lines.join("\n"));

const totalBytes = entries.reduce((n, e) => n + Buffer.from(e.b64, "base64").byteLength, 0);
console.log(
	`generate-starter-files: wrote ${entries.length} files (${totalBytes} bytes) → ${posix.relative(process.cwd(), OUTFILE.replace(/\\/g, "/"))}`,
);
