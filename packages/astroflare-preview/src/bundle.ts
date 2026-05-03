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
 * `$`-prefixed names; `render` is the framework entrypoint the wrapper
 * invokes; `jsx` / `jsxs` / `Fragment` / `jsxDEV` are the JSX-runtime names
 * MDX-compiled modules reference (see `mdx/index.ts`'s import-rewrite step).
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
	"$island",
	"render",
	"jsx",
	"jsxs",
	"jsxDEV",
	"Fragment",
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
 * Match a top-level `import` declaration whose specifier ends in a *compilable*
 * extension — `.astro`, `.md`, or `.mdx`. Captures the import clause (group 1)
 * for parsing into default / namespace / named bindings, and the specifier
 * (group 2). The clause-level parser (`parseImportClause`) handles every shape:
 *
 *     import X from "./Foo.md";
 *     import { frontmatter } from "./post.md";
 *     import * as ns from "./post.mdx";
 *     import X, { frontmatter } from "./post.md";
 *     import { a as b, c } from "./post.md";
 *
 * `.astro` modules typically only export `default`, but routing the import
 * through the same clause parser (rather than a default-only regex like
 * pre-Phase-14) keeps user-written named imports of `.astro` from being
 * silently dropped to step 2's "strip every other import" pass.
 */
const COMPILABLE_IMPORT_RE =
	/^[ \t]*import[ \t]+([^"';\n]+?)[ \t]+from[ \t]+["']([^"']+\.(?:astro|md|mdx))["'];?[ \t]*\r?\n?/gm;

/** Match `export default <expr>;` at line start (markdown compiler output). */
const EXPORT_DEFAULT_RE = /^[ \t]*export[ \t]+default[ \t]+/m;

/**
 * Match a top-level named export (function / class / const / let / var) at
 * the start of a line so the bundler can hoist them into the IIFE's
 * `__exports` map alongside `default`.
 *
 * Captures: 1=keyword (`function`/`class`/`const`/`let`/`var`), 2=name.
 * For functions we also accept an optional `async` qualifier.
 *
 * Note: esbuild's TS-strip pass rewrites `export const X = …` into a bare
 * declaration plus an `export { X }` block; in that case `EXPORT_LIST_RE`
 * below picks them up. This regex still matches the markdown compiler's
 * direct emission shape.
 */
const EXPORT_NAMED_RE =
	/^[ \t]*export[ \t]+(?:async[ \t]+)?(function|class|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm;

/**
 * Match esbuild's normalised export block:
 *
 *   export {
 *     stdin_default as default,
 *     getStaticPaths
 *   };
 *
 * Captures the brace contents (group 1) so the bundler can route each
 * binding to either `__default` or a named-export slot.
 */
const EXPORT_LIST_RE = /^[ \t]*export[ \t]*\{([^}]*)\}[ \t]*;?[ \t]*$/gm;

/**
 * Match a single named identifier — used for parsing import clauses and
 * named-export lists.
 */
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

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

	// 1. Rewrite cross-module imports of compilable files (`.astro`, `.md`,
	//    `.mdx`) into destructuring against the importee's IIFE return
	//    object. Every shape — default, named, namespace, mixed — folds into
	//    one or more `const ... = __m_<idx>.<...>` lines.
	body = body.replace(COMPILABLE_IMPORT_RE, (_, clause: string, spec: string) => {
		const importerDir = dirname(mod.path);
		const resolved = joinPath(importerDir, spec);
		const idx = idxByPath.get(resolved);
		const parsed = parseImportClause(clause);
		if (idx === undefined) {
			// Importee not in the closure — keep the original behaviour of
			// binding everything to `undefined` so user code at least
			// compiles. (Most often this means the importee was filtered
			// from the closure, e.g. a TS file that wasn't followed.)
			const lines: string[] = [`  // MISSING IMPORT: ${spec}`];
			if (parsed.default) lines.push(`  const ${parsed.default} = undefined;`);
			if (parsed.namespace) lines.push(`  const ${parsed.namespace} = undefined;`);
			for (const b of parsed.named) lines.push(`  const ${b.to} = undefined;`);
			return `${lines.join("\n")}\n`;
		}
		const lines: string[] = [];
		if (parsed.default) lines.push(`  const ${parsed.default} = __m_${idx}.default;`);
		if (parsed.namespace) lines.push(`  const ${parsed.namespace} = __m_${idx};`);
		if (parsed.named.length > 0) {
			const parts = parsed.named.map((b) => (b.from === b.to ? b.from : `${b.from}: ${b.to}`));
			lines.push(`  const { ${parts.join(", ")} } = __m_${idx};`);
		}
		return `${lines.join("\n")}\n`;
	});

	// 2. Strip every remaining top-level `import ...` line. The runtime import
	//    is now provided by the bundle's outer scope; non-compilable user
	//    imports are dropped.
	body = body.replace(ANY_IMPORT_LINE_RE, "");

	// 3. Rewrite `export default <expr>` to assign to __default.
	//    Markdown compiler emits this shape directly; esbuild's TS-strip
	//    pass produces the `export { X as default }` form which the
	//    EXPORT_LIST_RE pass below handles.
	body = body.replace(EXPORT_DEFAULT_RE, "  __default = ");

	// 4. Strip `export ` from named declarations and collect their names
	//    so the IIFE can include them in its return object. Phase 14
	//    drops the `NAMED_EXPORTS_OF_INTEREST` filter — every named export
	//    is exposed so cross-module `import { frontmatter } from "./x.md"`
	//    resolves. (The route wrapper still only consults `getStaticPaths`
	//    on the route module; surplus exports are inert.)
	body = body.replace(EXPORT_NAMED_RE, (full, _kw, name: string) => {
		const replacement = full.replace(/^([ \t]*)export[ \t]+/, "$1");
		namedExports.push(name);
		return replacement;
	});

	// 5. Handle esbuild's normalised `export { X as default, Y };` block —
	//    route each entry to the IIFE's return slots.
	body = body.replace(EXPORT_LIST_RE, (_, list: string) => {
		const lines: string[] = [];
		for (const part of list.split(",")) {
			const trimmed = part.trim();
			if (!trimmed) continue;
			const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
			if (asMatch) {
				const src = asMatch[1] as string;
				const dst = asMatch[2] as string;
				if (dst === "default") {
					lines.push(`  __default = ${src};`);
				} else {
					namedExports.push(dst);
					lines.push(`  const ${dst} = ${src};`);
				}
				continue;
			}
			// Bare `{ name }` — re-export of the same identifier.
			const bareMatch = IDENT_RE.exec(trimmed);
			if (bareMatch) {
				namedExports.push(trimmed);
			}
		}
		return lines.join("\n");
	});

	// 6. Indent for readability inside the IIFE; preserve blank lines.
	const indented = body
		.split("\n")
		.map((line) => (line.length === 0 ? "" : `  ${line}`))
		.join("\n");

	const final = indented.endsWith("\n") ? indented : `${indented}\n`;
	return { body: final, namedExports };
}

interface ImportClause {
	default?: string;
	namespace?: string;
	named: Array<{ from: string; to: string }>;
}

/**
 * Parse the part of an `import` statement that sits between `import` and
 * `from`. Handles every shape the bundler accepts:
 *
 *     X
 *     { a, b, c as d }
 *     * as ns
 *     X, { a, b }
 *     X, * as ns
 *
 * The result feeds into IIFE-destructuring: each part of the clause becomes
 * a `const … = __m_<idx>.…` line.
 */
function parseImportClause(clause: string): ImportClause {
	const out: ImportClause = { named: [] };
	const trimmed = clause.trim();
	if (!trimmed) return out;

	if (trimmed.startsWith("{")) {
		const close = trimmed.lastIndexOf("}");
		if (close > 0) {
			out.named = parseNamedList(trimmed.slice(1, close));
		}
		return out;
	}

	const nsOnlyMatch = /^\*[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(trimmed);
	if (nsOnlyMatch) {
		out.namespace = nsOnlyMatch[1] as string;
		return out;
	}

	const defWithRestMatch = /^([A-Za-z_$][\w$]*)(?:[ \t]*,[ \t]*([\s\S]+))?$/.exec(trimmed);
	if (defWithRestMatch) {
		out.default = defWithRestMatch[1] as string;
		const rest = (defWithRestMatch[2] ?? "").trim();
		if (rest.startsWith("{")) {
			const close = rest.lastIndexOf("}");
			if (close > 0) {
				out.named = parseNamedList(rest.slice(1, close));
			}
		} else {
			const nsMatch = /^\*[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(rest);
			if (nsMatch) out.namespace = nsMatch[1] as string;
		}
	}
	return out;
}

function parseNamedList(inner: string): Array<{ from: string; to: string }> {
	const out: Array<{ from: string; to: string }> = [];
	for (const part of inner.split(",")) {
		const p = part.trim();
		if (!p) continue;
		const asMatch = /^([A-Za-z_$][\w$]*)[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(p);
		if (asMatch) {
			out.push({ from: asMatch[1] as string, to: asMatch[2] as string });
		} else if (IDENT_RE.test(p)) {
			out.push({ from: p, to: p });
		}
	}
	return out;
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
