/**
 * Runtime ABI — what the compiler emits imports against.
 *
 * Compiled `.astro` modules look like:
 *
 *   import { $component, $render, $renderComponent, $renderSlot, $escape, ... }
 *     from "@astroflare/runtime/internal";
 *   import OtherComponent from "./Other.astro";
 *
 *   export default $component(async ({ Astro, ...$$props }, $$slots) => {
 *     // -- frontmatter --
 *     const { title } = Astro.props;
 *     // -- end frontmatter --
 *     return $render`
 *       <h1>${$escape(title)}</h1>
 *       ${await $renderComponent(OtherComponent, { x: 1 }, {
 *         default: async () => $render`hello`,
 *       })}
 *       ${$renderSlot($$slots, "default")}
 *     `;
 *   });
 *
 * The implementations below are deliberately small. Phase 3 swaps to a
 * streaming model (async iterables of HTML chunks) for large pages; the
 * compiler's emit shape doesn't change. Phase 8 wires real client-island
 * hydration; for now the placeholder marker just emits a comment.
 *
 * Each component invocation gets its own `Astro` global. Per-request fields
 * (request, url, params, site) are shared across the whole render tree;
 * `Astro.props` differs per component. We thread the per-request context
 * through `AsyncLocalStorage` so `$renderComponent` can build a child
 * `Astro` without callers having to pass it explicitly. `node:async_hooks`
 * is available in Node 22+ and in workerd under `nodejs_compat` (which
 * Astroflare requires).
 */
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RawHtml {
	readonly __astroRaw: true;
	readonly html: string;
}

export interface AstroComponentInstance {
	readonly __astroComponent: true;
}

export type SlotFn = () => unknown | Promise<unknown>;
export type SlotMap = Record<string, SlotFn>;

export type ComponentFn<P> = (props: P, slots: SlotMap) => unknown | Promise<unknown>;

export type AstroComponent<P> = ((props: P, slots: SlotMap) => Promise<RawHtml>) &
	AstroComponentInstance;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE_LOOKUP: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};
const ESCAPE_RE = /[&<>"']/g;

/** HTML-escape a value for safe embedding in either content or attributes. */
export function $escape(value: unknown): string {
	if (value == null || value === false) return "";
	if (value === true) return "true";
	if (isRawHtml(value)) return value.html;
	return String(value).replace(ESCAPE_RE, (c) => ESCAPE_LOOKUP[c] as string);
}

export function isRawHtml(value: unknown): value is RawHtml {
	return (
		typeof value === "object" && value !== null && (value as Partial<RawHtml>).__astroRaw === true
	);
}

/**
 * Wrap a string of pre-rendered HTML in a marker so that downstream `$render`
 * calls don't double-escape it. Public surface for `set:html={x}`.
 */
export function $rawHtml(value: unknown): RawHtml {
	if (value == null) return { __astroRaw: true, html: "" };
	if (isRawHtml(value)) return value;
	return { __astroRaw: true, html: String(value) };
}

/**
 * Recursively flatten a value into an HTML string. Async because nested
 * `$render` results are promises and component renders are async.
 */
async function flatten(value: unknown): Promise<string> {
	if (value == null || value === false) return "";
	if (value === true) return "true";
	if (typeof value === "string") return $escape(value);
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	if (isRawHtml(value)) return value.html;
	if (typeof (value as { then?: unknown }).then === "function") {
		return flatten(await (value as Promise<unknown>));
	}
	if (Array.isArray(value)) {
		const parts = await Promise.all(value.map(flatten));
		return parts.join("");
	}
	return $escape(String(value));
}

// ---------------------------------------------------------------------------
// Template tag — the heart of compiled output
// ---------------------------------------------------------------------------

/**
 * Tagged template that interleaves static HTML strings with interpolated
 * values. Returns a `RawHtml` marker so it nests without double-escaping.
 *
 *   $render`<div>${user.name}</div>`
 *     // -> { __astroRaw: true, html: "<div>Alice</div>" }
 */
export async function $render(
	strings: TemplateStringsArray,
	...values: unknown[]
): Promise<RawHtml> {
	let html = strings[0] as string;
	for (let i = 0; i < values.length; i++) {
		html += await flatten(values[i]);
		html += strings[i + 1] as string;
	}
	return { __astroRaw: true, html };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Wrap a render function so the compiler's default export tags itself as an
 * Astroflare component. The wrapper coerces whatever the user returns into a
 * `RawHtml` marker so downstream callers can rely on the shape.
 */
export function $component<P>(cb: ComponentFn<P>): AstroComponent<P> {
	const fn = (async (props: P, slots: SlotMap) => {
		const result = await cb(props, slots);
		if (isRawHtml(result)) return result;
		return { __astroRaw: true, html: await flatten(result) };
	}) as AstroComponent<P>;
	(fn as { __astroComponent: true }).__astroComponent = true;
	return fn;
}

export async function $renderComponent<P>(
	Component: AstroComponent<P>,
	props: P,
	slots: SlotMap = {},
): Promise<RawHtml> {
	if (typeof Component !== "function") {
		throw new TypeError(`$renderComponent: expected a component, got ${typeof Component}`);
	}
	// Each component gets its own `Astro` (different `props`, shared request
	// context). The wrapper-level `render()` establishes the context via
	// `withRenderContext`; nested calls reach for it via the ALS.
	const componentArg = Object.assign({ Astro: makeChildAstro(props) }, props);
	return Component(componentArg as P, slots);
}

// ---------------------------------------------------------------------------
// Per-request context propagation (used by render() and $renderComponent)
// ---------------------------------------------------------------------------

/** Subset of `RenderContext` that's invariant across the render tree. */
export interface SharedRenderContext {
	request: Request;
	url: URL;
	params: Record<string, string>;
	site?: string;
}

const renderContextStore = new AsyncLocalStorage<SharedRenderContext>();

/** Read the current per-request context (set by `withRenderContext`). */
export function getRenderContext(): SharedRenderContext | undefined {
	return renderContextStore.getStore();
}

/** Run `fn` with the supplied per-request context bound. */
export function withRenderContext<R>(ctx: SharedRenderContext, fn: () => R): R {
	return renderContextStore.run(ctx, fn);
}

interface AstroLike<P> {
	props: P;
	params: Record<string, string>;
	request: Request | undefined;
	url: URL | undefined;
	site: string | undefined;
	redirect: (to: string, status?: 301 | 302 | 303 | 307 | 308) => Response;
}

function makeChildAstro<P>(props: P): AstroLike<P> {
	const ctx = renderContextStore.getStore();
	return {
		props,
		params: ctx?.params ?? {},
		request: ctx?.request,
		url: ctx?.url,
		site: ctx?.site,
		redirect(to, status = 302) {
			return new Response(null, { status, headers: { location: to } });
		},
	};
}

export async function $renderSlot(
	slots: SlotMap,
	name = "default",
	fallback?: () => unknown,
): Promise<RawHtml> {
	const slot = slots[name];
	if (slot) {
		const result = await slot();
		return { __astroRaw: true, html: await flatten(result) };
	}
	if (fallback) {
		const result = await fallback();
		return { __astroRaw: true, html: await flatten(result) };
	}
	return { __astroRaw: true, html: "" };
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/** `<div {...obj}>` → `$spreadAttrs({ class: "x", id: "y" })`. */
export function $spreadAttrs(obj: Record<string, unknown> | null | undefined): RawHtml {
	if (obj == null) return { __astroRaw: true, html: "" };
	let html = "";
	for (const [key, value] of Object.entries(obj)) {
		if (value == null || value === false) continue;
		if (value === true) {
			html += ` ${key}`;
		} else {
			html += ` ${key}="${$escape(value)}"`;
		}
	}
	return { __astroRaw: true, html };
}

/**
 * Interpolate a single attribute value safely. Used by the emitter for
 * `name={expr}` where `name` is an HTML element attribute.
 */
export function $attr(value: unknown): string {
	if (value == null || value === false) return "";
	if (value === true) return "";
	return $escape(value);
}

/**
 * Emit a complete attribute pair `' name="escaped-value"'` (or `' name'` for
 * `true`, or empty for null/false). The emitter uses this for both `name={expr}`
 * and `{name}` shorthand attributes — both reduce to "render a name/value pair
 * conditionally on the value's truthiness."
 */
export function $attrPair(name: string, value: unknown): RawHtml {
	if (value == null || value === false) return { __astroRaw: true, html: "" };
	if (value === true) return { __astroRaw: true, html: ` ${name}` };
	return { __astroRaw: true, html: ` ${name}="${$escape(value)}"` };
}

/**
 * `<script define:vars={{ user }}>...</script>` — emits a `const x = JSON;`
 * preamble. Phase 2 emits literally; Phase 8 may add type narrowing.
 */
export function $defineVars(vars: Record<string, unknown>): RawHtml {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(vars)) {
		lines.push(`const ${key} = ${JSON.stringify(value)};`);
	}
	return { __astroRaw: true, html: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Hydration markers (Phase 8 wires real hydration)
// ---------------------------------------------------------------------------

export interface HydrationDirective {
	mode: "load" | "idle" | "visible" | "media" | "only";
	mediaQuery?: string;
	rendererName?: string;
}

/**
 * Phase 2: emit a placeholder comment so we can verify the parser/emitter
 * pipeline routes client directives correctly. Phase 8 replaces this with a
 * real `<astro-island>` custom element instance and per-island client bundle
 * URL.
 */
export function $hydrationMarker(directive: HydrationDirective): RawHtml {
	const meta = `mode=${directive.mode}${
		directive.mediaQuery ? ` media=${JSON.stringify(directive.mediaQuery)}` : ""
	}${directive.rendererName ? ` renderer=${directive.rendererName}` : ""}`;
	return {
		__astroRaw: true,
		html: `<!-- astroflare:hydration ${meta} -->`,
	};
}

/**
 * Render any value (component result, render template, primitive, etc.) into
 * a final HTML string. The public-facing entrypoint for the rendering
 * pipeline; the preview server / build pipeline call this.
 */
export async function renderToString(value: unknown): Promise<string> {
	if (value == null) return "";
	if (isRawHtml(value)) return value.html;
	return flatten(value);
}
