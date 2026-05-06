/**
 * JSX runtime — two callers:
 *
 *   1. `@mdx-js/mdx`-compiled `.mdx` files (automatic-runtime shape).
 *      MDX (with `jsxImportSource: "@astroflare/runtime"`) compiles to:
 *
 *        import {jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment}
 *          from "@astroflare/runtime/jsx-runtime";
 *
 *        function _createMdxContent(props) {
 *          return _jsxs("h1", { children: "Hello" });
 *        }
 *
 *   2. JSX-in-expression bodies inside `.astro` files (classic-runtime
 *      shape via the `$$jsx` / `$$Fragment` pragmas). The compiler
 *      emitter dumps the user's expression source verbatim into a
 *      `$render` template literal interpolation; sucrase's classic JSX
 *      transform then lowers any JSX tags it encounters to
 *      `$$jsx(type, props, ...children)` calls. See
 *      `packages/compiler/src/ts.ts`.
 *
 * Both shapes resolve to a `RawHtml` marker — the same shape the rest of
 * the runtime uses — so they compose naturally with `$render` and other
 * RawHtml-aware sites without double-escaping.
 *
 * Three element-type cases:
 *   1. `Fragment` (the symbol below) — render children only.
 *   2. `string` (e.g. `"h1"`, `"div"`) — emit an HTML element with attrs +
 *      children. Void elements (`<br/>`, `<img/>`, …) self-close.
 *   3. `function` — invoke as a component. Astroflare components (those
 *      flagged with `__astroComponent`) flow through `$renderComponent`
 *      so they get a per-call `Astro` and slot map; plain function
 *      components (the shape MDX uses for nested helpers) are called
 *      directly with `props`.
 *
 * Children handling: a child can be a string, number, RawHtml, Promise, or
 * (recursively) an array of those. Strings are HTML-escaped; RawHtml is
 * embedded verbatim; everything else stringifies and escapes.
 *
 * Phase 14 carve-outs:
 *   - We don't honour the React-flavoured `key` argument; MDX never uses
 *     it for a stringly server-render anyway.
 *   - `dangerouslySetInnerHTML` (React's escape hatch) isn't supported —
 *     `set:html` already covers that surface in `.astro`, and `.mdx`
 *     embeds raw HTML directly via Markdown.
 *   - The classic JSX runtime (`React.createElement`-style) isn't
 *     provided; MDX ≥ 2 defaults to automatic, so this isn't a real gap.
 */

import {
	$escape,
	$rawHtml,
	$renderComponent,
	type AstroComponent,
	type RawHtml,
	type SlotMap,
	isRawHtml,
} from "./internal.js";

export const Fragment: unique symbol = Symbol.for("astroflare.jsx.Fragment");

/**
 * Self-closing HTML elements per the WHATWG list. These are emitted as
 * `<tag .../>` rather than `<tag ...>...</tag>`. MDX won't put children on
 * them; the check guards user-authored MDX that does.
 */
const VOID_ELEMENTS = new Set([
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
	"param",
	"source",
	"track",
	"wbr",
]);

/**
 * React-style attribute names that map to HTML's lowercase form. MDX
 * defaults to HTML attribute names directly, but user-authored JSX in
 * `.mdx` may use the React conventions. Mapping these two keeps both
 * paths working without a full attribute table.
 */
const ATTR_NAME_MAP: Record<string, string> = {
	className: "class",
	htmlFor: "for",
};

interface JsxProps {
	children?: unknown;
	[key: string]: unknown;
}

type AstroComponentLike = AstroComponent<unknown> & { __astroComponent?: true };
type ComponentLike = AstroComponentLike | ((props: unknown) => unknown);

/**
 * The JSX automatic-runtime entrypoint. The MDX compiler emits
 * `_jsx(type, props, key?)` calls for every element in the tree.
 */
export async function jsx(
	type: typeof Fragment | string | ComponentLike,
	props: JsxProps | null | undefined,
	_key?: unknown,
): Promise<RawHtml> {
	const safeProps = (props ?? {}) as JsxProps;

	if (type === Fragment) {
		return $rawHtml(await renderChildren(safeProps.children));
	}

	if (typeof type === "function") {
		if ((type as { __astroComponent?: true }).__astroComponent === true) {
			return invokeAstroComponent(type as AstroComponentLike, safeProps);
		}
		const result = await (type as (props: unknown) => unknown)(safeProps);
		return $rawHtml(await renderValue(result));
	}

	if (typeof type === "string") {
		return $rawHtml(await renderElement(type, safeProps));
	}

	// Unknown element type — render nothing rather than throw, so a single
	// malformed node doesn't take out the whole tree.
	return $rawHtml("");
}

/** `jsxs` is the multi-children variant; same semantics for our purposes. */
export const jsxs = jsx;

/** `jsxDEV` — the dev-mode variant MDX emits when `development: true`. */
export const jsxDEV = jsx;

/**
 * Classic-runtime JSX entrypoint, used by the `.astro` compile pipeline
 * for JSX inside expression bodies. Sucrase's classic transform lowers
 * `<li>{x}</li>` to `$$jsx("li", null, x)` — children are varargs, not
 * a `props.children` field. We reshape to the automatic-runtime call
 * convention and delegate to `jsx`, which already handles every element
 * type case (Fragment, string, function component, Astroflare component,
 * RawHtml, primitives, arrays, promises).
 *
 * Children handling parallels React.createElement: zero children → no
 * `children` prop, one child → scalar `children`, many → array. The
 * downstream `renderChildren` flatten handles both shapes.
 */
export async function $$jsx(
	type: typeof Fragment | string | ComponentLike,
	props: Record<string, unknown> | null | undefined,
	...children: unknown[]
): Promise<RawHtml> {
	const merged: JsxProps = { ...(props ?? {}) };
	if (children.length === 1) {
		merged.children = children[0];
	} else if (children.length > 1) {
		merged.children = children;
	}
	return jsx(type, merged);
}

/**
 * Fragment sentinel for the classic JSX runtime. Same identity as the
 * automatic-runtime `Fragment`, so the renderer doesn't need to track
 * which transform produced a given tree.
 */
export const $$Fragment = Fragment;

async function invokeAstroComponent(type: AstroComponentLike, props: JsxProps): Promise<RawHtml> {
	const { children, ...rest } = props;
	const slots: SlotMap = {};
	if (children !== undefined) {
		slots.default = async () => $rawHtml(await renderChildren(children));
	}
	const result = await $renderComponent(type, rest, slots);
	if (result instanceof Response) {
		throw new Error(
			"jsx-runtime: Astroflare component in JSX returned a Response — " +
				"redirects are only valid on the route module's frontmatter.",
		);
	}
	return result;
}

async function renderElement(tag: string, props: JsxProps): Promise<string> {
	const { children, ...attrs } = props;
	let attrString = "";
	for (const [name, value] of Object.entries(attrs)) {
		if (value == null || value === false) continue;
		const htmlName = ATTR_NAME_MAP[name] ?? name;
		if (value === true) {
			attrString += ` ${htmlName}`;
		} else {
			attrString += ` ${htmlName}="${$escape(value)}"`;
		}
	}
	if (VOID_ELEMENTS.has(tag)) {
		return `<${tag}${attrString} />`;
	}
	const inner = await renderChildren(children);
	return `<${tag}${attrString}>${inner}</${tag}>`;
}

/**
 * Recursively flatten a JSX `children` value to an HTML string. Mirrors
 * the runtime's existing `flatten` (in `internal.ts`) but uses the JSX
 * convention where `children` may be a single value or an array.
 */
async function renderChildren(children: unknown): Promise<string> {
	if (children == null || children === false) return "";
	if (Array.isArray(children)) {
		const parts = await Promise.all(children.map(renderValue));
		return parts.join("");
	}
	return renderValue(children);
}

async function renderValue(value: unknown): Promise<string> {
	if (value == null || value === false) return "";
	if (value === true) return "true";
	if (typeof value === "string") return $escape(value);
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	if (isRawHtml(value)) return value.html;
	if (typeof (value as { then?: unknown }).then === "function") {
		return renderValue(await (value as Promise<unknown>));
	}
	if (Array.isArray(value)) {
		return renderChildren(value);
	}
	return $escape(String(value));
}
