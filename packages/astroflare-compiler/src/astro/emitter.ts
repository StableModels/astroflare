/**
 * AST → ESM emitter for `.astro`.
 *
 * Output ABI (§7.2 of the brief): a default export of a render function whose
 * shape matches what `@astroflare/runtime/internal#$component` expects:
 *
 *   import { $component, $render, ... } from "@astroflare/runtime/internal";
 *   // user's frontmatter imports stay where the user wrote them
 *
 *   export default $component(async ({ Astro, ...$$props }, $$slots) => {
 *     // ── frontmatter (verbatim) ──
 *     ...
 *     return $render` ... `;
 *   });
 *
 * Most of the emitter's job is producing the *body* of that template literal,
 * recursively walking the AST. Each node maps to:
 *   - text         → literal HTML (with backticks and `${` defensively escaped)
 *   - expression   → `${expr}`             — runtime `flatten` does the escaping
 *   - element      → `<tag${attrs}>...children...</tag>` (or void / self-close)
 *   - component    → `${await $renderComponent(Name, props, slots)}`
 *   - slot         → `${await $renderSlot($$slots, "name", () => fallback)}`
 *   - directive    → consumed by emitter; produces a runtime call instead of a literal
 *   - fragment     → flattened into siblings
 *   - comment      → `<!-- ... -->`
 *   - doctype      → `<!doctype html>`
 *
 * Phase 2 carve-outs (documented in the retro):
 *   - `is:raw` is parsed but not yet special-cased; expressions inside an
 *     `is:raw` element are still evaluated. Fix: route children of `is:raw`
 *     elements through the original source range.
 *   - Source maps not produced.
 *   - TS frontmatter passes through unchanged; TS→JS happens downstream.
 */
import type {
	AstroAttribute,
	AstroComponent,
	AstroDocument,
	AstroElement,
	AstroFragmentNode,
	AstroNode,
	AstroSlot,
	DirectiveAttribute,
	ExpressionAttribute,
	ShorthandAttribute,
	SpreadAttribute,
	StaticAttribute,
} from "./ast.js";
import { scopeCss } from "./css-scope.js";
import { buildLineMap } from "./source-map.js";

export interface EmitOptions {
	/** Module specifier for the runtime ABI imports. */
	runtimeImport?: string;
	/** Optional source filename used for error reporting and source maps. */
	filename?: string;
	/**
	 * 8-char per-component CSS scope hash. When supplied, the emitter
	 * attaches `data-aflare-h="<hash>"` to every HTML element it emits and
	 * rewrites scoped `<style>` blocks so their selectors target only
	 * elements bearing the same attribute. Computed by `compileAstro`
	 * from the source filename.
	 */
	scopeHash?: string;
}

export interface EmitResult {
	code: string;
	/**
	 * Phase 13: a v3 source map mapping each generated line back to
	 * line 1, column 0 of the original `.astro` source. Per-token
	 * mappings using each AST node's `range` is a Phase 23 carryover.
	 */
	map: import("./source-map.js").SourceMapV3 | null;
}

const DEFAULT_RUNTIME_IMPORT = "@astroflare/runtime/internal";

/** All runtime symbols the emitter may reach for. Imported unconditionally so
 * the emitter doesn't have to track which ones a given file actually uses;
 * tree-shaking handles dead removal at deploy time. */
const RUNTIME_SYMBOLS = [
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
] as const;

const CLIENT_DIRECTIVE_MODES = new Set([
	"client:load",
	"client:idle",
	"client:visible",
	"client:media",
	"client:only",
]);

const VOID_HTML_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
]);

export function emitDocument(doc: AstroDocument, opts: EmitOptions = {}): EmitResult {
	const runtime = opts.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;
	const importLine = `import { ${RUNTIME_SYMBOLS.join(", ")} } from ${JSON.stringify(runtime)};`;
	const fm = doc.frontmatter ?? "";
	// Hoist any top-level `export ...` declarations (e.g. `getStaticPaths`)
	// out of the frontmatter to module scope. The remainder runs inside the
	// component arrow.
	const { hoisted, remaining } = hoistTopLevelExports(fm);
	// Compute scoping context so emitElement can decorate elements + style
	// blocks with the right hash. `scopeHash` is supplied by compileAstro.
	const hasScopedStyle = opts.scopeHash !== undefined && documentHasScopedStyle(doc.body);
	// Phase 16: scan the frontmatter (post-hoisting; the original imports
	// are still in `hoisted`) for `import` statements so emitComponent can
	// look up an island's source path when generating $island URLs.
	const islandImports = parseFrontmatterImports(hoisted);
	const ctx: EmitContext = {
		slotsRef: "$$slots",
		scopeHash: hasScopedStyle ? (opts.scopeHash ?? null) : null,
		islandImports,
		importerPath: opts.filename ?? null,
	};
	const body = emitChildren(doc.body, "$$slots", ctx);
	const hoistedBlock = hoisted.length > 0 ? `${hoisted.join("\n")}\n` : "";
	const code = `${importLine}\n${hoistedBlock}export default $component(async ({ Astro, ...$$props }, $$slots) => {\n${remaining}\nreturn $render\`${body}\`;\n});\n`;
	// Phase 13: emit a structural source map. The original source string
	// isn't available to the emitter (it works from a parsed AST); the
	// caller in `compileAstro` pairs the map with the source.
	const map = opts.filename ? buildLineMap(code, "", opts.filename) : null;
	return { code, map };
}

/**
 * Does this document contain at least one `<style>` element WITHOUT
 * `is:global`? Only those drive scoping; a global-only document shouldn't
 * pay the per-element data-attribute cost.
 */
function documentHasScopedStyle(nodes: readonly AstroNode[]): boolean {
	for (const node of nodes) {
		if (node.type === "element") {
			if (node.name.toLowerCase() === "style") {
				const directives = collectDirectives(node.attrs);
				if (!directives.isGlobal) return true;
			}
			if (documentHasScopedStyle(node.children)) return true;
		} else if (node.type === "fragment" || node.type === "component") {
			if (documentHasScopedStyle(node.children)) return true;
		}
	}
	return false;
}

/**
 * Extract top-level `import` and `export` declarations from frontmatter
 * source so they land at module scope rather than inside the component
 * arrow.
 *
 * Recognised forms (parity with Astro):
 *   - `import X from "spec";` and every other top-level `import` shape
 *   - `export async function NAME(...) { … }`
 *   - `export function NAME(...) { … }`
 *   - `export class NAME { … }`
 *   - `export (const|let|var) NAME = …;`     // semicolon-terminated
 *
 * Imports must hoist because (a) `import` is a syntax error inside an
 * arrow body and (b) the TS-strip pass (esbuild-wasm) parses the
 * pre-bundler output. Exports hoist for the same reason.
 *
 * Other top-level `export`s (re-exports, `export type`, default exports)
 * are left in place — the emitter does not own a real JS parser.
 *
 * Walks character-by-character with brace/paren/bracket-depth tracking and
 * simple string/template handling so we can find depth-0 statement
 * boundaries reliably without a full parser.
 */
export function hoistTopLevelExports(source: string): {
	hoisted: string[];
	remaining: string;
} {
	const hoisted: string[] = [];
	const keep: string[] = [];
	let i = 0;
	while (i < source.length) {
		const lineStart = i;
		// Find next newline or end-of-string.
		const nl = source.indexOf("\n", i);
		const lineEnd = nl < 0 ? source.length : nl;
		const line = source.slice(lineStart, lineEnd);
		const trimmed = line.trimStart();
		const match = matchHoistableDeclaration(trimmed);
		if (match) {
			const stmtStart = lineStart + (line.length - trimmed.length);
			const stmtEnd = findStatementEnd(source, stmtStart, match.kind);
			if (stmtEnd > stmtStart) {
				hoisted.push(source.slice(stmtStart, stmtEnd));
				i = stmtEnd;
				// Skip the trailing newline if present so we don't emit a
				// blank line where the export used to be.
				if (source[i] === "\n") i++;
				continue;
			}
		}
		keep.push(line);
		i = lineEnd;
		if (i < source.length) {
			keep.push("\n");
			i++;
		}
	}
	return { hoisted, remaining: keep.join("") };
}

interface ExportMatch {
	kind: "fn" | "class" | "decl" | "import";
}

const IMPORT_RE =
	/^import\b[ \t\r\n]*(?:type[ \t]+)?(?:[\w$*,{}\s]+[ \t]+from[ \t]+)?["'][^"']+["']/;
const EXPORT_FN_RE =
	/^export[ \t]+(?:async[ \t]+)?function[ \t]+(?:\*[ \t]*)?[A-Za-z_$][\w$]*[ \t]*\(/;
const EXPORT_CLASS_RE = /^export[ \t]+class[ \t]+[A-Za-z_$][\w$]*\b/;
const EXPORT_DECL_RE = /^export[ \t]+(?:const|let|var)[ \t]+[A-Za-z_$][\w$]*/;

function matchHoistableDeclaration(line: string): ExportMatch | null {
	if (IMPORT_RE.test(line)) return { kind: "import" };
	if (EXPORT_FN_RE.test(line)) return { kind: "fn" };
	if (EXPORT_CLASS_RE.test(line)) return { kind: "class" };
	if (EXPORT_DECL_RE.test(line)) return { kind: "decl" };
	return null;
}

/**
 * Find the byte offset where an export statement ends, starting from
 * `start`. For function/class declarations: the index just past the
 * matching depth-0 `}`. For const/let/var: the index just past the
 * depth-0 `;` (or end-of-source).
 */
function findStatementEnd(source: string, start: number, kind: ExportMatch["kind"]): number {
	let i = start;
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let openedBraces = false;
	while (i < source.length) {
		const ch = source[i];
		// Strings + template literals + comments — skip past them so we don't
		// mistake their internal punctuation for statement boundaries.
		if (ch === '"' || ch === "'") {
			i = skipString(source, i, ch);
			continue;
		}
		if (ch === "`") {
			i = skipTemplate(source, i);
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			i = source.indexOf("\n", i);
			if (i < 0) return source.length;
			i++;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end < 0 ? source.length : end + 2;
			continue;
		}
		if (ch === "(") parenDepth++;
		else if (ch === ")") parenDepth--;
		else if (ch === "[") bracketDepth++;
		else if (ch === "]") bracketDepth--;
		else if (ch === "{") {
			braceDepth++;
			openedBraces = true;
		} else if (ch === "}") {
			braceDepth--;
			if (
				(kind === "fn" || kind === "class") &&
				braceDepth === 0 &&
				parenDepth === 0 &&
				bracketDepth === 0 &&
				openedBraces
			) {
				return i + 1;
			}
		} else if (
			ch === ";" &&
			(kind === "decl" || kind === "import") &&
			braceDepth === 0 &&
			parenDepth === 0 &&
			bracketDepth === 0
		) {
			return i + 1;
		} else if (
			ch === "\n" &&
			(kind === "decl" || kind === "import") &&
			braceDepth === 0 &&
			parenDepth === 0 &&
			bracketDepth === 0
		) {
			// Auto-semicolon: `import x from "y"` followed by newline (no `;`),
			// or the same shape for const/let/var.
			return i;
		}
		i++;
	}
	return source.length;
}

function skipString(source: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < source.length) {
		const ch = source[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === quote) return i + 1;
		i++;
	}
	return source.length;
}

function skipTemplate(source: string, start: number): number {
	let i = start + 1;
	while (i < source.length) {
		const ch = source[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "`") return i + 1;
		if (ch === "$" && source[i + 1] === "{") {
			// Skip the interpolation block — recurse-via-loop with brace depth.
			i += 2;
			let depth = 1;
			while (i < source.length && depth > 0) {
				const c = source[i];
				if (c === "{") depth++;
				else if (c === "}") depth--;
				else if (c === '"' || c === "'") {
					i = skipString(source, i, c);
					continue;
				} else if (c === "`") {
					i = skipTemplate(source, i);
					continue;
				}
				i++;
			}
			continue;
		}
		i++;
	}
	return source.length;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface EmitContext {
	slotsRef: string;
	/**
	 * 8-char hash for scoped CSS, or `null` when the document has no
	 * scoped `<style>` block. When set, `emitElement` adds
	 * `data-aflare-h="<hash>"` to every HTML element.
	 */
	scopeHash: string | null;
	/**
	 * Map of component identifier → import specifier, parsed from the
	 * frontmatter's `import` statements (Phase 16). Used by
	 * `emitComponent` when a `client:*` directive is present so the
	 * emitted `$island(...)` call can record where the component lives,
	 * which the client-side hydration runtime fetches via the preview
	 * server's `/_aflare/island` route.
	 */
	islandImports: Map<string, string>;
	/**
	 * Workspace path of the file being emitted (when known). Combined
	 * with `componentSpec` at runtime to produce the absolute URL the
	 * hydration runtime fetches. Null when the compiler has no filename
	 * (test scenarios that compile bare strings).
	 */
	importerPath: string | null;
}

function emitChildren(nodes: readonly AstroNode[], slotsRef: string, parent?: EmitContext): string {
	const ctx: EmitContext = parent ?? {
		slotsRef,
		scopeHash: null,
		islandImports: new Map(),
		importerPath: null,
	};
	let out = "";
	for (const node of nodes) out += emitNode(node, ctx);
	return out;
}

function emitNode(node: AstroNode, ctx: EmitContext): string {
	switch (node.type) {
		case "text":
			return escapeTemplateLiteral(node.value);
		case "expression":
			return interpolate(node.expression);
		case "element":
			return emitElement(node, ctx);
		case "component":
			return emitComponent(node, ctx);
		case "fragment":
			return emitFragment(node, ctx);
		case "slot":
			return emitSlot(node, ctx);
		case "comment":
			return `<!--${escapeTemplateLiteral(node.value)}-->`;
		case "doctype":
			return `<!doctype ${node.value}>`;
	}
}

function emitElement(el: AstroElement, ctx: EmitContext): string {
	const directives = collectDirectives(el.attrs);

	// Scoped/global `<style>` elements emit verbatim CSS; no scope-attr.
	if (el.name.toLowerCase() === "style") {
		return emitStyleElement(el, ctx, directives);
	}

	// `set:html={x}` replaces children with the raw HTML.
	if (directives.setHtml) {
		const baseAttrs = emitAttrs(el.attrs, /* skipSlot */ false, /* skipDirectives */ true);
		const scopeAttr = scopeAttrFor(ctx);
		const open = `<${el.name}${baseAttrs}${scopeAttr}>`;
		const close = `</${el.name}>`;
		return `${open}${interpolate(`$rawHtml(${directives.setHtml})`)}${close}`;
	}

	// `define:vars={...}` prepends `const x = ...; ` to the children block.
	const definePrefix = directives.defineVars
		? interpolate(`$defineVars(${directives.defineVars})`)
		: "";

	const attrs = emitAttrs(el.attrs, /* skipSlot */ false, /* skipDirectives */ true);
	const scopeAttr = scopeAttrFor(ctx);
	const open = `<${el.name}${attrs}${scopeAttr}`;

	if (el.selfClosing || VOID_HTML_ELEMENTS.has(el.name.toLowerCase())) {
		return `${open}/>`;
	}
	const children = emitChildren(el.children, ctx.slotsRef, ctx);
	return `${open}>${definePrefix}${children}</${el.name}>`;
}

/**
 * Emit a `<style>` element. Scripts and other raw-text elements pass
 * through the normal text-child path, but `<style>` is special:
 *
 *   - `<style is:global>` — pass through as-is, dropping the directive.
 *   - `<style>` — extract CSS, run through `scopeCss`, emit with the
 *     same hash as the data attribute applied to surrounding elements.
 *
 * In both cases the output is a literal `<style>` tag in the HTML
 * stream — no runtime template interpolation, so the CSS is opaque to
 * the runtime's value flatteners.
 */
function emitStyleElement(
	el: AstroElement,
	ctx: EmitContext,
	directives: CollectedDirectives,
): string {
	const css = el.children.length === 0 ? "" : (el.children[0] as { value: string }).value;
	const attrsHtml = emitAttrs(el.attrs, /* skipSlot */ false, /* skipDirectives */ true);
	if (directives.isGlobal || ctx.scopeHash === null) {
		return `<style${attrsHtml}>${escapeTemplateLiteral(css)}</style>`;
	}
	const scoped = scopeCss(css, `[data-aflare-h="${ctx.scopeHash}"]`);
	return `<style${attrsHtml}>${escapeTemplateLiteral(scoped)}</style>`;
}

function scopeAttrFor(ctx: EmitContext): string {
	if (ctx.scopeHash === null) return "";
	return ` data-aflare-h="${ctx.scopeHash}"`;
}

function emitComponent(node: AstroComponent, ctx: EmitContext): string {
	const partitioned = partitionSlots(node.children);
	const propsExpr = emitPropsExpression(node.attrs);
	const slotsExpr = emitSlotsExpression(partitioned, ctx);
	const directives = collectDirectives(node.attrs);
	const callExpr = `await $renderComponent(${node.name}, ${propsExpr}, ${slotsExpr})`;
	if (directives.client) {
		// Phase 16: emit a real `$island(...)` wrapper. The runtime helper
		// produces `<astro-island …>…</astro-island>` markup; the client-
		// side runtime (`hydration-client.ts`) registers the custom
		// element and triggers hydration.
		//
		// For Astroflare components (.astro imports), SSR through the
		// existing renderer is fine — pass the SSR callback so the island
		// wraps real HTML. For React-style imports (.tsx / .jsx) the
		// component reference will be undefined in the bundle (the inline
		// bundler doesn't follow non-compilable imports), and even if it
		// were available, our jsx-runtime doesn't support hooks. Pass
		// `null` for those so the island starts empty and hydrates fresh.
		const componentSpec = ctx.islandImports.get(node.name) ?? null;
		const ssrCallback = canSsrIsland(componentSpec) ? `async () => ${callExpr}` : "null";
		const islandOpts = JSON.stringify({
			componentName: node.name,
			componentSpec,
			importerPath: ctx.importerPath,
			directive: {
				mode: directives.client.mode,
				...(directives.client.mediaQuery !== undefined
					? { mediaQuery: directives.client.mediaQuery }
					: {}),
			},
		});
		const islandCall = `await $island({...${islandOpts}, props: ${propsExpr}}, ${ssrCallback})`;
		return interpolate(islandCall);
	}
	return interpolate(callExpr);
}

/**
 * Decide whether the SSR callback for an island should run. Astroflare
 * (`.astro`) and Markdown components SSR cleanly through the existing
 * renderer; React (`.tsx` / `.jsx`) components don't, until Phase 16b
 * lands real React SSR with hooks.
 */
function canSsrIsland(componentSpec: string | null): boolean {
	if (!componentSpec) return true; // unknown source — best-effort SSR
	return /\.(astro|md|mdx)$/.test(componentSpec);
}

function emitFragment(node: AstroFragmentNode, ctx: EmitContext): string {
	return emitChildren(node.children, ctx.slotsRef, ctx);
}

function emitSlot(node: AstroSlot, ctx: EmitContext): string {
	const fallback =
		node.children.length > 0
			? `, async () => $render\`${emitChildren(node.children, ctx.slotsRef, ctx)}\``
			: "";
	const callExpr = `await $renderSlot(${ctx.slotsRef}, ${JSON.stringify(node.name)}${fallback})`;
	return interpolate(callExpr);
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function emitAttrs(
	attrs: readonly AstroAttribute[],
	skipSlot: boolean,
	skipDirectives: boolean,
): string {
	let out = "";
	for (const attr of attrs) {
		if (skipSlot && attr.type === "static" && attr.name === "slot") continue;
		if (skipDirectives && attr.type === "directive") continue;
		out += emitAttr(attr);
	}
	return out;
}

function emitAttr(attr: AstroAttribute): string {
	switch (attr.type) {
		case "static":
			if (attr.boolean) return ` ${attr.name}`;
			return ` ${attr.name}="${escapeAttribute(attr.value)}"`;
		case "expression":
			return interpolate(`$attrPair(${JSON.stringify(attr.name)}, ${attr.expression})`);
		case "shorthand":
			return interpolate(`$attrPair(${JSON.stringify(attr.name)}, ${attr.expression})`);
		case "spread":
			return interpolate(`$spreadAttrs(${attr.expression})`);
		case "template":
			return interpolate(`$attrPair(${JSON.stringify(attr.name)}, \`${attr.expression}\`)`);
		case "directive":
			// Directives are usually consumed by the emitter; if one slips through
			// here, render it as a literal attribute so we don't lose information.
			if (attr.expression == null) return ` ${attr.name}`;
			return ` ${attr.name}="${escapeAttribute(attr.expression)}"`;
	}
}

// ---------------------------------------------------------------------------
// Component props / slots
// ---------------------------------------------------------------------------

function emitPropsExpression(attrs: readonly AstroAttribute[]): string {
	const parts: string[] = [];
	for (const attr of attrs) {
		if (attr.type === "directive") continue;
		if (attr.type === "static" && attr.name === "slot") continue;
		switch (attr.type) {
			case "static":
				parts.push(`${jsKey(attr.name)}: ${attr.boolean ? "true" : JSON.stringify(attr.value)}`);
				break;
			case "expression":
				parts.push(`${jsKey(attr.name)}: (${attr.expression})`);
				break;
			case "shorthand":
				parts.push(`${jsKey(attr.name)}: (${attr.expression})`);
				break;
			case "spread":
				parts.push(`...(${attr.expression})`);
				break;
			case "template":
				parts.push(`${jsKey(attr.name)}: \`${attr.expression}\``);
				break;
		}
	}
	if (parts.length === 0) return "{}";
	return `{ ${parts.join(", ")} }`;
}

interface PartitionedSlots {
	default: AstroNode[];
	named: Map<string, AstroNode[]>;
}

function partitionSlots(children: readonly AstroNode[]): PartitionedSlots {
	const result: PartitionedSlots = { default: [], named: new Map() };
	for (const child of children) {
		const slotName = childSlotName(child);
		if (slotName === null) {
			result.default.push(child);
		} else {
			let bucket = result.named.get(slotName);
			if (!bucket) {
				bucket = [];
				result.named.set(slotName, bucket);
			}
			bucket.push(child);
		}
	}
	return result;
}

function childSlotName(child: AstroNode): string | null {
	if (child.type !== "element" && child.type !== "component") return null;
	for (const attr of child.attrs) {
		if (attr.type === "static" && attr.name === "slot") return attr.value;
	}
	return null;
}

function emitSlotsExpression(slots: PartitionedSlots, ctx: EmitContext): string {
	const entries: string[] = [];
	if (slots.default.length > 0) {
		entries.push(
			`default: async () => $render\`${emitChildrenStrippingSlot(slots.default, ctx)}\``,
		);
	}
	for (const [name, nodes] of slots.named) {
		entries.push(`${jsKey(name)}: async () => $render\`${emitChildrenStrippingSlot(nodes, ctx)}\``);
	}
	if (entries.length === 0) return "{}";
	return `{ ${entries.join(", ")} }`;
}

function emitChildrenStrippingSlot(nodes: readonly AstroNode[], parentCtx: EmitContext): string {
	const ctx: EmitContext = parentCtx;
	let out = "";
	for (const node of nodes) {
		// Drop the `slot=` attribute on direct slot children — it's been routed.
		if (node.type === "element" || node.type === "component") {
			const stripped = {
				...node,
				attrs: node.attrs.filter((a) => !(a.type === "static" && a.name === "slot")),
			};
			out += emitNode(stripped as typeof node, ctx);
		} else {
			out += emitNode(node, ctx);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

interface CollectedDirectives {
	setHtml: string | null;
	defineVars: string | null;
	isRaw: boolean;
	isGlobal: boolean;
	client: { mode: string; mediaQuery?: string } | null;
}

function collectDirectives(attrs: readonly AstroAttribute[]): CollectedDirectives {
	const out: CollectedDirectives = {
		setHtml: null,
		defineVars: null,
		isRaw: false,
		isGlobal: false,
		client: null,
	};
	for (const attr of attrs) {
		if (attr.type !== "directive") continue;
		const dir = attr as DirectiveAttribute;
		if (dir.name === "set:html" && dir.expression != null) {
			out.setHtml = dir.expression;
		} else if (dir.name === "define:vars" && dir.expression != null) {
			out.defineVars = dir.expression;
		} else if (dir.name === "is:raw") {
			out.isRaw = true;
		} else if (dir.name === "is:global") {
			out.isGlobal = true;
		} else if (CLIENT_DIRECTIVE_MODES.has(dir.name)) {
			const mode = dir.name.slice("client:".length);
			out.client = {
				mode,
				...(dir.expression != null && mode === "media"
					? { mediaQuery: stripQuotes(dir.expression) }
					: {}),
			};
		}
	}
	return out;
}

/**
 * Phase 16: scan hoisted `import` statements for component identifiers
 * and their source specifiers. Used to populate `EmitContext.islandImports`
 * so `<Counter client:load />` can encode Counter's path in the
 * `$island(...)` URL.
 *
 * Recognised forms (parity with the bundler's `parseImportClause`):
 *   - `import X from "..."`                      default
 *   - `import { a, b as c } from "..."`          named (with alias)
 *   - `import * as ns from "..."`                namespace
 *   - `import X, { a, b } from "..."`            mixed
 *
 * The map's keys are the *local* names (post-alias). Aliased imports
 * register under the alias because that's what `<Counter />` references
 * in the body.
 */
function parseFrontmatterImports(hoisted: readonly string[]): Map<string, string> {
	const out = new Map<string, string>();
	const re =
		/^[ \t]*import[ \t]+([^"';\n]+?)[ \t]+from[ \t]+["']([^"']+)["']/gm;
	for (const stmt of hoisted) {
		if (!stmt.trimStart().startsWith("import")) continue;
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic loop
		while ((m = re.exec(stmt)) !== null) {
			const clause = (m[1] as string).trim();
			const spec = m[2] as string;
			recordImportClause(out, clause, spec);
		}
	}
	return out;
}

function recordImportClause(out: Map<string, string>, clause: string, spec: string): void {
	if (clause.startsWith("{")) {
		const close = clause.lastIndexOf("}");
		if (close > 0) recordNamedList(out, clause.slice(1, close), spec);
		return;
	}
	const nsMatch = /^\*[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(clause);
	if (nsMatch) {
		out.set(nsMatch[1] as string, spec);
		return;
	}
	const defMatch = /^([A-Za-z_$][\w$]*)(?:[ \t]*,[ \t]*([\s\S]+))?$/.exec(clause);
	if (!defMatch) return;
	out.set(defMatch[1] as string, spec);
	const rest = (defMatch[2] ?? "").trim();
	if (rest.startsWith("{")) {
		const close = rest.lastIndexOf("}");
		if (close > 0) recordNamedList(out, rest.slice(1, close), spec);
	} else {
		const nm = /^\*[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(rest);
		if (nm) out.set(nm[1] as string, spec);
	}
}

function recordNamedList(out: Map<string, string>, inner: string, spec: string): void {
	for (const part of inner.split(",")) {
		const p = part.trim();
		if (!p) continue;
		const aliasMatch = /^([A-Za-z_$][\w$]*)[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(p);
		if (aliasMatch) {
			out.set(aliasMatch[2] as string, spec);
		} else if (/^[A-Za-z_$][\w$]*$/.test(p)) {
			out.set(p, spec);
		}
	}
}

function stripQuotes(expression: string): string {
	const trimmed = expression.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return JSON.parse(`"${trimmed.slice(1, -1).replace(/"/g, '\\"')}"`);
	}
	return expression;
}

// ---------------------------------------------------------------------------
// Template-literal escaping
// ---------------------------------------------------------------------------

/**
 * Escape characters that have special meaning inside a `\`...\`` template
 * literal: backticks, `${`, and backslashes.
 */
function escapeTemplateLiteral(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function escapeAttribute(value: string): string {
	return escapeTemplateLiteral(value).replace(/"/g, "&quot;");
}

function interpolate(expression: string): string {
	return `\${${expression}}`;
}

const SAFE_KEY = /^[A-Za-z_$][\w$]*$/;
function jsKey(name: string): string {
	if (SAFE_KEY.test(name)) return name;
	return JSON.stringify(name);
}

// Avoid an unused-export warning for the internal helper imports — these are
// referenced inside template strings and would otherwise look unused.
export type {
	AstroComponent,
	AstroElement,
	AstroNode,
	DirectiveAttribute,
	ExpressionAttribute,
	ShorthandAttribute,
	SpreadAttribute,
	StaticAttribute,
};
