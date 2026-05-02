/**
 * Server-side render helpers consumed by `.astro`-compiled modules.
 *
 * The compiled output's default export has signature
 * `(result, props, slots) => Promise<string>` — the framework constructs
 * `result` via {@link createResult} and passes it in.
 */

export type SlotFn = () => Promise<string> | string;
export type SlotsRecord = Record<string, SlotFn>;

export type AstroComponent = (
  result: AstroResult,
  props: Record<string, unknown>,
  slots?: SlotsRecord,
) => Promise<string>;

export interface AstroResult {
  escape(value: unknown): string;
  attr(name: string, value: unknown): string;
  attrs(obj: Record<string, unknown> | null | undefined): string;
  renderComponent(
    component: AstroComponent | unknown,
    props: Record<string, unknown>,
    slots: SlotsRecord,
  ): Promise<string>;
  renderSlot(slots: SlotsRecord | undefined, name: string, fallback?: SlotFn): Promise<string>;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// biome-ignore lint/suspicious/noShadowRestrictedNames: matches Astro's runtime API.
export function escape(value: unknown): string {
  if (value == null || value === false) return "";
  const s = typeof value === "string" ? value : String(value);
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Render a single attribute. Mirrors Astro's ergonomics:
 *   - `false` / `null` / `undefined` → omit the attribute entirely.
 *   - `true` → render as a boolean attribute (`disabled`).
 *   - everything else → render as `name="<escaped>"`.
 */
export function attr(name: string, value: unknown): string {
  if (value === false || value == null) return "";
  if (value === true) return ` ${name}`;
  return ` ${name}="${escapeAttrValue(String(value))}"`;
}

export function attrs(obj: Record<string, unknown> | null | undefined): string {
  if (!obj) return "";
  let out = "";
  for (const [k, v] of Object.entries(obj)) {
    out += attr(k, v);
  }
  return out;
}

export async function renderComponent(
  component: AstroComponent | unknown,
  props: Record<string, unknown>,
  slots: SlotsRecord,
): Promise<string> {
  if (typeof component !== "function") {
    throw new TypeError(
      `renderComponent: expected a function-shaped component, got ${typeOf(component)}`,
    );
  }
  const result = createResult();
  const out = await (component as AstroComponent)(result, props, slots);
  return typeof out === "string" ? out : String(out ?? "");
}

export async function renderSlot(
  slots: SlotsRecord | undefined,
  name: string,
  fallback?: SlotFn,
): Promise<string> {
  const fn = slots?.[name];
  if (fn) {
    const out = await fn();
    return typeof out === "string" ? out : String(out ?? "");
  }
  if (fallback) {
    const out = await fallback();
    return typeof out === "string" ? out : String(out ?? "");
  }
  return "";
}

export function createResult(): AstroResult {
  return {
    escape,
    attr,
    attrs,
    renderComponent,
    renderSlot,
  };
}

function escapeAttrValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}
