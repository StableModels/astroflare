import { build } from "esbuild";
const result = await build({
	entryPoints: ["packages/astroflare-host-cloudflare/src/project-worker.ts"],
	bundle: true,
	format: "esm",
	platform: "neutral",
	target: "es2022",
	external: ["cloudflare:workers", "node:async_hooks"],
	conditions: ["workerd"],
	metafile: true,
	write: false,
	loader: { ".wasm": "binary" },
});
console.log("output bytes:", result.outputFiles[0].contents.length);
const meta = result.metafile;
const inputs = Object.entries(meta.inputs)
	.sort((a, b) => b[1].bytes - a[1].bytes)
	.slice(0, 8);
console.log("top 8 inputs:");
for (const [path, info] of inputs) console.log("  ", info.bytes.toString().padStart(8), path);
