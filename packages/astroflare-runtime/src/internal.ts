import { AsyncLocalStorage } from "node:async_hooks";
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
import type { AstroCookies, AstroSlots } from "@astroflare/core";

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

export type AstroComponent<P> = ((props: P, slots: SlotMap) => Promise<RawHtml | Response>) &
	AstroComponentInstance;

/**
 * Sentinel error raised when a component returns a `Response` from its
 * frontmatter (typically `Astro.redirect("/x")`). Caught by `render()`
 * and translated into a structured `RenderResult` of kind `"response"`.
 *
 * Throwing is the cleanest non-local return — the alternative (typing
 * the entire $renderComponent chain to forward `Response | RawHtml`)
 * would force every caller to handle both branches.
 */
export class ResponseSignal extends Error {
	readonly response: Response;
	constructor(response: Response) {
		super("astroflare:response-signal");
		this.response = response;
	}
}

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
 * `RawHtml` marker so downstream callers can rely on the shape — except for
 * `Response`, which short-circuits via `ResponseSignal`.
 */
export function $component<P>(cb: ComponentFn<P>): AstroComponent<P> {
	const fn = (async (props: P, slots: SlotMap) => {
		const result = await cb(props, slots);
		if (result instanceof Response) {
			throw new ResponseSignal(result);
		}
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
): Promise<RawHtml | Response> {
	if (typeof Component !== "function") {
		throw new TypeError(`$renderComponent: expected a component, got ${typeof Component}`);
	}
	// Each component gets its own `Astro` (different `props`, shared request
	// context, child-specific slot map). The wrapper-level `render()`
	// establishes the context via `withRenderContext`; nested calls reach
	// for it via the ALS.
	const componentArg = Object.assign({ Astro: makeChildAstro(props, slots) }, props);
	return Component(componentArg as P, slots);
}

// ---------------------------------------------------------------------------
// Per-request context propagation (used by render() and $renderComponent)
// ---------------------------------------------------------------------------

/**
 * Subset of `RenderContext` that's invariant across the render tree.
 * `cookies` is shared by reference so writes from one component are
 * visible to siblings; `locals` is similarly shared.
 */
export interface SharedRenderContext {
	request: Request;
	url: URL;
	params: Record<string, string>;
	site?: string;
	cookies?: AstroCookies;
	locals?: Record<string, unknown>;
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
	cookies: AstroCookies;
	locals: Record<string, unknown>;
	slots: AstroSlots;
}

function makeChildAstro<P>(props: P, slots: SlotMap): AstroLike<P> {
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
		cookies: ctx?.cookies ?? noopCookies(),
		locals: ctx?.locals ?? {},
		slots: makeAstroSlots(slots),
	};
}

/**
 * Build the `Astro.slots` imperative API from a slot map. `has(name)` is a
 * presence check; `render(name)` invokes the slot's render function and
 * flattens to an HTML string (parity with Astro).
 */
export function makeAstroSlots(slots: SlotMap): AstroSlots {
	return {
		has(name: string): boolean {
			return Object.prototype.hasOwnProperty.call(slots, name);
		},
		async render(name: string): Promise<string> {
			const fn = slots[name];
			if (!fn) return "";
			const result = await fn();
			return flatten(result);
		},
	};
}

/**
 * Default cookie surface used when no per-request `AstroCookies` is bound
 * (e.g. a component renders outside `render()` in a one-off test). Reads
 * are empty; writes are silently dropped.
 */
function noopCookies(): AstroCookies {
	return {
		get: () => undefined,
		has: () => false,
		set: () => {},
		delete: () => {},
		headers: () => [],
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
 * Phase 2 placeholder — kept as a thin wrapper for back-compat. Phase 16
 * upgrades the real hydration path to `$island(...)` (see below); the
 * marker stays in case anything still consults it.
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

// ---------------------------------------------------------------------------
// Phase 16: islands — real `<astro-island>` wrapping for `client:*` directives
// ---------------------------------------------------------------------------

export interface IslandOptions {
	/** The component identifier as written by the user (e.g., `"Counter"`). */
	componentName: string;
	/**
	 * The import specifier that brought the component in (e.g.,
	 * `"../components/Counter.tsx"`). Null if the component wasn't
	 * imported (defined inline) — that case is rare and the URL will be
	 * empty. Combined with `importerPath` to construct an absolute URL.
	 */
	componentSpec: string | null;
	/**
	 * The workspace path of the file emitting the island (e.g.,
	 * `"/src/pages/index.astro"`). Used as the resolution base for
	 * `componentSpec`.
	 */
	importerPath: string | null;
	/** Hydration trigger directive (`load` / `idle` / `visible` / `media`). */
	directive: HydrationDirective;
	/** Props the component receives at hydration time. JSON-serialised. */
	props: Record<string, unknown>;
}

/**
 * Server-side island wrapper. Produces `<astro-island>` markup containing:
 *   - hydration metadata as attributes (uid, component-url, client:directive)
 *   - props as a `<script type="application/json" data-aflare-props>`
 *   - the SSR'd component HTML when `ssrCallback` is provided (and succeeds);
 *     empty otherwise — the client-side hydration runtime mounts fresh
 *
 * The `<astro-island>` custom element is defined by the hydration client
 * (`hydration-client.ts`); it boots the right trigger handler on
 * connection and dynamically imports the component bundle on hydration.
 *
 * Phase 16 carve-out: SSR through React with hooks isn't supported. If the
 * user's component is a `.astro` (server-renderable), `ssrCallback` runs and
 * the SSR HTML is included. If it's a `.tsx`/`.jsx` import, the compiler
 * passes `null` for `ssrCallback` and the island wraps an empty placeholder
 * — equivalent to `client:only` for now. Phase 16b adds React SSR.
 */
export async function $island(
	opts: IslandOptions,
	ssrCallback: (() => Promise<unknown>) | null,
): Promise<RawHtml> {
	let ssrHtml = "";
	if (ssrCallback) {
		try {
			const result = await ssrCallback();
			if (isRawHtml(result)) {
				ssrHtml = result.html;
			} else if (result != null) {
				ssrHtml = await flatten(result);
			}
		} catch {
			// SSR failed — most likely the component reference was undefined
			// because the import got stripped from the bundle. Fall back to
			// empty island; client hydration will mount fresh.
		}
	}

	const uid = generateIslandUid();
	const componentUrl = buildComponentUrl(opts);
	const directiveAttr = directiveToAttribute(opts.directive);
	const propsJson = JSON.stringify(opts.props ?? {});

	return {
		__astroRaw: true,
		html:
			`<astro-island uid="${uid}"` +
			` component-url="${$escape(componentUrl)}"` +
			` component-name="${$escape(opts.componentName)}"` +
			directiveAttr +
			">" +
			`<script type="application/json" data-aflare-props>${embedJson(propsJson)}</script>` +
			ssrHtml +
			"</astro-island>",
	};
}

let islandCounter = 0;

/**
 * Generate a per-render island UID. Falls back to a process-local counter
 * when `crypto.randomUUID` isn't available (older Node, some test
 * environments). The UID only needs to be unique within a single page
 * render — it's how the client-side runtime distinguishes islands when
 * multiple appear on the page.
 */
function generateIslandUid(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) {
		return c.randomUUID().replace(/-/g, "").slice(0, 8);
	}
	return `i${(islandCounter++).toString(36).padStart(4, "0")}`;
}

/**
 * Build the URL the hydration runtime fetches the component bundle from.
 * Resolves `componentSpec` relative to `importerPath`'s directory so the
 * preview / deploy server can locate the source file.
 *
 * Returns an empty string if the spec is null — caller should treat that
 * as "no source available, hydration will be a no-op."
 */
function buildComponentUrl(opts: IslandOptions): string {
	if (!opts.componentSpec) return "";
	const importerDir = opts.importerPath ? dirOf(opts.importerPath) : "/";
	const resolved = resolveSpec(importerDir, opts.componentSpec);
	const params = new URLSearchParams();
	params.set("path", resolved);
	return `/_aflare/island?${params.toString()}`;
}

function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** Tiny POSIX-style path resolver — sufficient for relative spec → workspace path. */
function resolveSpec(base: string, spec: string): string {
	if (spec.startsWith("/")) return spec;
	const segments = `${base}/${spec}`.split("/");
	const stack: string[] = [];
	for (const seg of segments) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			stack.pop();
			continue;
		}
		stack.push(seg);
	}
	return `/${stack.join("/")}`;
}

function directiveToAttribute(d: HydrationDirective): string {
	let attr = ` client:${d.mode}`;
	if (d.mediaQuery) attr += `="${$escape(d.mediaQuery)}"`;
	return attr;
}

/** Defang `</script>` and `<!--` inside embedded JSON so the surrounding
 * `<script type="application/json">` block can't be terminated early.
 */
function embedJson(json: string): string {
	return json.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
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
