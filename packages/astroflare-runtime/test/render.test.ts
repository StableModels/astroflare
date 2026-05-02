import { describe, expect, it } from "vitest";
import {
  attr,
  attrs,
  type createResult,
  // biome-ignore lint/suspicious/noShadowRestrictedNames: matches Astro's runtime API.
  escape,
  renderComponent,
  renderSlot,
} from "../src/render.js";

describe("escape", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escape("<script>'\"x&y\"'</script>")).toBe(
      "&lt;script&gt;&#39;&quot;x&amp;y&quot;&#39;&lt;/script&gt;",
    );
  });

  it("returns empty string for null/undefined/false", () => {
    expect(escape(null)).toBe("");
    expect(escape(undefined)).toBe("");
    expect(escape(false)).toBe("");
  });

  it("stringifies non-strings", () => {
    expect(escape(42)).toBe("42");
    expect(escape(true)).toBe("true");
  });
});

describe("attr", () => {
  it('emits leading-space, name="value" form for primitives', () => {
    expect(attr("class", "foo")).toBe(' class="foo"');
    expect(attr("data-x", 7)).toBe(' data-x="7"');
  });

  it('escapes & and " inside the attribute value', () => {
    expect(attr("title", "'a&b\"c")).toBe(' title="\'a&amp;b&quot;c"');
  });

  it("renders true as a boolean attribute and omits null/undefined/false", () => {
    expect(attr("disabled", true)).toBe(" disabled");
    expect(attr("disabled", false)).toBe("");
    expect(attr("disabled", null)).toBe("");
    expect(attr("disabled", undefined)).toBe("");
  });
});

describe("attrs", () => {
  it("emits attributes for each entry, in iteration order", () => {
    expect(attrs({ a: "1", b: "2" })).toBe(' a="1" b="2"');
  });

  it("returns empty string for null/undefined", () => {
    expect(attrs(null)).toBe("");
    expect(attrs(undefined)).toBe("");
  });
});

describe("renderComponent", () => {
  it("invokes the component function with a fresh result, the props, and the slots", async () => {
    const component = async (
      result: ReturnType<typeof createResult>,
      props: { name: string },
      _slots: Record<string, () => Promise<string>>,
    ) => `<h1>${result.escape(props.name)}</h1>`;
    const out = await renderComponent(component, { name: "<x>" }, {});
    expect(out).toBe("<h1>&lt;x&gt;</h1>");
  });

  it("throws TypeError when given a non-function", async () => {
    await expect(renderComponent("nope" as unknown, {}, {})).rejects.toThrow(TypeError);
  });
});

describe("renderSlot", () => {
  it("returns the named slot's output", async () => {
    const out = await renderSlot({ default: async () => "hi" }, "default");
    expect(out).toBe("hi");
  });

  it("returns the fallback when the slot is missing", async () => {
    const out = await renderSlot({}, "footer", async () => "fallback");
    expect(out).toBe("fallback");
  });

  it("returns empty string when no slot, no fallback", async () => {
    expect(await renderSlot(undefined, "default")).toBe("");
    expect(await renderSlot({}, "default")).toBe("");
  });

  it("supports synchronous slot/fallback functions", async () => {
    expect(await renderSlot({ d: () => "sync" }, "d")).toBe("sync");
    expect(await renderSlot({}, "x", () => "fb")).toBe("fb");
  });
});
