/**
 * Inline bundler — flatten a closure of compiled modules into a single ESM
 * file with one outer `import` (the runtime). Each module becomes an IIFE
 * that returns its `default` export; user `.astro` imports are rewritten to
 * references to those IIFEs' return values.
 *
 * Why this shape: vitest's vite-node module loader intercepts dynamic
 * `import()` and tries to SSR-transform the loaded files. Multi-module
 * bundles in the executor's tmp directory have nested relative imports
 * (`../components/Layout.js`) that vite-node mis-resolves, producing
 * "'import', and 'export' cannot be used outside of module code" errors.
 * Phase 2.5 documented this. The single-file inline bundle bypasses the
 * issue entirely — there are no inter-module imports for vite-node to
 * misinterpret. Aligns with §9.1 of the brief: "Above ~256 KB, do not
 * inline modules in `WorkerCode`" — below that, inline is the expected shape.
 *
 * Phase 4 carve-outs (in retro):
 *   - Only user `import X from "./Y.astro"` (default imports of `.astro`
 *     files) are rewritten. Named/namespace imports of `.astro` files are
 *     not handled (Astro components only have a default export anyway).
 *   - Any other top-level import in user frontmatter is stripped silently.
 *     Phase 6 (CSS / JSON) and Phase 8 (.ts / framework helpers) add proper
 *     handling.
 *   - No source maps. Bundle line numbers don't map back to source.
 */
import { dirname, joinPath } from "@astroflare/core";
import type { ModuleInfo } from "./module-graph.js";

/**
 * Runtime symbols imported by the bundle. The compiler-emitted ABI uses the
 * first eleven; `render` is the framework entrypoint the wrapper invokes.
 */
const BUNDLE_RUNTIME_SYMBOLS = [
	"$component",
	"$render",
	"$renderComponent",
	"$renderSlot",
	"$escape",
	"$rawHtml",
	"$attr",
	"$attrPair",
	"$spreadAttrs",
	"$defineVars",
	"$hydrationMarker",
	"render",
] as const;

/**
 * Match a top-level `import` statement of any of the forms the compiler emits
 * or that user frontmatter typically uses:
 *
 *   import "spec";
 *   import X from "spec";
 *   import { a, b } from "spec";          // including names with `$`
 *   import * as ns from "spec";
 *   import X, { a, b } from "spec";
 *   import type { T } from "spec";
 *
 * The `[\w$]` class explicitly admits `$` (used in the runtime ABI symbol
 * names — `\w` alone wouldn't match `$component`).
 */
const ANY_IMPORT_LINE_RE =
	/^[ \t]*import\b(?:[ \t]+(?:type[ \t]+)?[\w$*,{}\s]+[ \t]+from)?[ \t]+["'][^"']+["'];?[ \t]*\r?\n?/gm;

/**
 * Match `import <ident> from "<spec>.astro";` — captures the local binding
 * name (group 1) and the specifier (group 2).
 */
const ASTRO_DEFAULT_IMPORT_RE =
	/^[ \t]*import[ \t]+(\w+)[ \t]+from[ \t]+["']([^"']+\.astro)["'];?[ \t]*\r?\n?/gm;

/** Match `export default <expr>;` at line start. */
const EXPORT_DEFAULT_RE = /^[ \t]*export[ \t]+default[ \t]+/m;

/**
 * Match a top-level named export (function / class / const / let / var) at
 * the start of a line so the bundler can hoist them into the IIFE's
 * `__exports` map alongside `default`.
 *
 * Captures: 1=keyword (`function`/`class`/`const`/`let`/`var`), 2=name.
 * For functions we also accept an optional `async` qualifier.
 */
const EXPORT_NAMED_RE =
	/^[ \t]*export[ \t]+(?:async[ \t]+)?(function|class|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm;

/**
 * Names exposed by route modules in addition to `default`. Bundles unwrap
 * these from the per-module IIFE so the page wrapper can reach for them
 * (e.g. `getStaticPaths` for dynamic-route deploys).
 */
const NAMED_EXPORTS_OF_INTEREST = ["getStaticPaths"] as const;

export function inlineBundle(modules: readonly ModuleInfo[], runtimeImport: string): string {
	if (modules.length === 0) throw new Error("inlineBundle: empty closure");

	const ordered = topoSort(modules);
	const idxByPath = new Map<string, number>();
	ordered.forEach((m, i) => idxByPath.set(m.path, i));

	// `closure()` returns root-first (DFS pre-order). The route is `modules[0]`.
	const route = modules[0] as ModuleInfo;
	const routeIdx = idxByPath.get(route.path);
	if (routeIdx === undefined) {
		throw new Error(`inlineBundle: route ${route.path} missing from topo sort`);
	}

	let out = `import { ${BUNDLE_RUNTIME_SYMBOLS.join(", ")} } from ${JSON.stringify(runtimeImport)};\n\n`;

	for (let i = 0; i < ordered.length; i++) {
		const mod = ordered[i] as ModuleInfo;
		out += `// Module ${i}: ${mod.path}\n`;
		out += `const __m_${i} = (() => {\n`;
		out += "  let __default;\n";
		const { body: rendered, namedExports } = renderModuleBody(mod, idxByPath);
		out += rendered;
		const namedFields = namedExports.length > 0 ? `, ${namedExports.join(", ")}` : "";
		out += `  return { default: __default${namedFields} };\n`;
		out += "})();\n\n";
	}

	// Top-level wrapper. Two invocation modes, discriminated by `ctx.kind`:
	//   - `"paths"` → return the route's `getStaticPaths()` result (build-time
	//     enumeration for dynamic routes), or `null` if the route doesn't
	//     export one.
	//   - default  → run the renderer over the route module.
	out += [
		"export default async (ctx) => {",
		`  if (ctx && ctx.kind === "paths") {`,
		`    const fn = __m_${routeIdx}.getStaticPaths;`,
		"    return fn ? await fn() : null;",
		"  }",
		`  return render(__m_${routeIdx}.default, ctx);`,
		"};",
		"",
	].join("\n");
	return out;
}

interface RenderedModule {
	body: string;
	namedExports: string[];
}

function renderModuleBody(mod: ModuleInfo, idxByPath: Map<string, number>): RenderedModule {
	let body = mod.compiled;
	const namedExports: string[] = [];

	// 1. Replace user .astro default imports with const bindings to other
	//    IIFEs' `default` fields (the IIFE returns `{ default, ... }`).
	body = body.replace(ASTRO_DEFAULT_IMPORT_RE, (_, varName, spec) => {
		const importerDir = dirname(mod.path);
		const resolved = joinPath(importerDir, spec);
		const idx = idxByPath.get(resolved);
		if (idx === undefined) {
			return `  // MISSING IMPORT: ${spec}\n  const ${varName} = undefined;\n`;
		}
		return `  const ${varName} = __m_${idx}.default;\n`;
	});

	// 2. Strip every remaining top-level `import ...` line. The runtime import
	//    is now provided by the bundle's outer scope; non-.astro user imports
	//    are dropped (Phase 4 limitation, documented in retro).
	body = body.replace(ANY_IMPORT_LINE_RE, "");

	// 3. Rewrite `export default <expr>` to assign to __default.
	body = body.replace(EXPORT_DEFAULT_RE, "  __default = ");

	// 4. Strip `export ` from named declarations and remember their names so
	//    the IIFE can include them in its return object. Restricted to the
	//    set of names the bundle wrapper actually consults — other named
	//    exports stay as the framework adds them, but they're invisible to
	//    importers, which matches the Phase 4 carve-out.
	body = body.replace(EXPORT_NAMED_RE, (full, kw, name) => {
		const replacement = full.replace(/^([ \t]*)export[ \t]+/, "$1");
		if ((NAMED_EXPORTS_OF_INTEREST as readonly string[]).includes(name)) {
			namedExports.push(name);
		}
		void kw;
		return replacement;
	});

	// 5. Indent for readability inside the IIFE; preserve blank lines.
	const indented = body
		.split("\n")
		.map((line) => (line.length === 0 ? "" : `  ${line}`))
		.join("\n");

	const final = indented.endsWith("\n") ? indented : `${indented}\n`;
	return { body: final, namedExports };
}

function topoSort(modules: readonly ModuleInfo[]): ModuleInfo[] {
	const byPath = new Map<string, ModuleInfo>();
	for (const m of modules) byPath.set(m.path, m);

	const visited = new Set<string>();
	const out: ModuleInfo[] = [];

	function visit(mod: ModuleInfo): void {
		if (visited.has(mod.path)) return;
		visited.add(mod.path);
		for (const depPath of mod.resolvedImports) {
			const dep = byPath.get(depPath);
			if (dep) visit(dep);
		}
		out.push(mod);
	}

	for (const m of modules) visit(m);
	return out;
}
