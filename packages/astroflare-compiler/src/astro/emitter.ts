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

export interface EmitOptions {
	/** Module specifier for the runtime ABI imports. */
	runtimeImport?: string;
	/** Optional source filename used for error reporting and source maps. */
	filename?: string;
}

export interface EmitResult {
	code: string;
	/** Source map placeholder; filled in a later phase. */
	map: null;
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
	const body = emitChildren(doc.body, "$$slots");
	const code = `${importLine}\nexport default $component(async ({ Astro, ...$$props }, $$slots) => {\n${fm}\nreturn $render\`${body}\`;\n});\n`;
	return { code, map: null };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface EmitContext {
	slotsRef: string;
}

function emitChildren(nodes: readonly AstroNode[], slotsRef: string): string {
	const ctx: EmitContext = { slotsRef };
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

	// `set:html={x}` replaces children with the raw HTML.
	if (directives.setHtml) {
		const open = `<${el.name}${emitAttrs(el.attrs, /* skipSlot */ false, /* skipDirectives */ true)}>`;
		const close = `</${el.name}>`;
		return `${open}${interpolate(`$rawHtml(${directives.setHtml})`)}${close}`;
	}

	// `define:vars={...}` prepends `const x = ...; ` to the children block.
	const definePrefix = directives.defineVars
		? interpolate(`$defineVars(${directives.defineVars})`)
		: "";

	const attrs = emitAttrs(el.attrs, /* skipSlot */ false, /* skipDirectives */ true);
	const open = `<${el.name}${attrs}`;

	if (el.selfClosing || VOID_HTML_ELEMENTS.has(el.name.toLowerCase())) {
		return `${open}/>`;
	}
	const children = emitChildren(el.children, ctx.slotsRef);
	return `${open}>${definePrefix}${children}</${el.name}>`;
}

function emitComponent(node: AstroComponent, ctx: EmitContext): string {
	const partitioned = partitionSlots(node.children);
	const propsExpr = emitPropsExpression(node.attrs);
	const slotsExpr = emitSlotsExpression(partitioned, ctx.slotsRef);
	const directives = collectDirectives(node.attrs);
	const callExpr = `await $renderComponent(${node.name}, ${propsExpr}, ${slotsExpr})`;
	if (directives.client) {
		// Phase 8 wires real hydration; for now emit a marker before the
		// rendered component so tests can verify the parse-and-route path.
		const marker = `$hydrationMarker(${JSON.stringify({ mode: directives.client.mode, mediaQuery: directives.client.mediaQuery })})`;
		return `${interpolate(marker)}${interpolate(callExpr)}`;
	}
	return interpolate(callExpr);
}

function emitFragment(node: AstroFragmentNode, ctx: EmitContext): string {
	return emitChildren(node.children, ctx.slotsRef);
}

function emitSlot(node: AstroSlot, ctx: EmitContext): string {
	const fallback =
		node.children.length > 0
			? `, async () => $render\`${emitChildren(node.children, ctx.slotsRef)}\``
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

function emitSlotsExpression(slots: PartitionedSlots, slotsRef: string): string {
	const entries: string[] = [];
	if (slots.default.length > 0) {
		entries.push(
			`default: async () => $render\`${emitChildrenStrippingSlot(slots.default, slotsRef)}\``,
		);
	}
	for (const [name, nodes] of slots.named) {
		entries.push(
			`${jsKey(name)}: async () => $render\`${emitChildrenStrippingSlot(nodes, slotsRef)}\``,
		);
	}
	if (entries.length === 0) return "{}";
	return `{ ${entries.join(", ")} }`;
}

function emitChildrenStrippingSlot(nodes: readonly AstroNode[], slotsRef: string): string {
	const ctx: EmitContext = { slotsRef };
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
	client: { mode: string; mediaQuery?: string } | null;
}

function collectDirectives(attrs: readonly AstroAttribute[]): CollectedDirectives {
	const out: CollectedDirectives = {
		setHtml: null,
		defineVars: null,
		isRaw: false,
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
