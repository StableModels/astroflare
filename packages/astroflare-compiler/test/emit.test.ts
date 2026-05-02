import { describe, expect, it } from "vitest";
import { compileAstro } from "../src/index.js";

describe("emit — render function shape", () => {
  it("produces a default-export async function with the (result, props, slots) ABI", () => {
    const { code } = compileAstro("<h1>hi</h1>");
    expect(code).toContain("export default async function $$render(result, props, slots)");
  });

  it("hoists frontmatter imports above the render function", () => {
    const { code } = compileAstro(
      `---\nimport Layout from "./Layout.astro";\nconst x = 1;\n---\n<Layout>{x}</Layout>`,
    );
    const importIdx = code.indexOf('import Layout from "./Layout.astro"');
    const renderIdx = code.indexOf("export default async function $$render");
    const xIdx = code.indexOf("const x = 1;");
    expect(importIdx).toBeGreaterThanOrEqual(0);
    expect(renderIdx).toBeGreaterThanOrEqual(0);
    expect(xIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeLessThan(renderIdx);
    // Non-import frontmatter goes inside the render body.
    expect(xIdx).toBeGreaterThan(renderIdx);
  });

  it("emits text as JSON-quoted string concatenation", () => {
    const { code } = compileAstro("<p>hello</p>");
    expect(code).toContain('$$out += "<p"');
    expect(code).toContain('$$out += ">"');
    expect(code).toContain('$$out += "hello"');
    expect(code).toContain('$$out += "</p>"');
  });

  it("emits interpolations as $$result.escape() calls", () => {
    const { code } = compileAstro("<p>{name}</p>");
    expect(code).toContain("$$out += $$result.escape(name)");
  });

  it("emits expression attributes via $$result.attr()", () => {
    const { code } = compileAstro("<a href={url}></a>");
    expect(code).toContain('$$out += $$result.attr("href", url)');
  });

  it("emits spread attributes via $$result.attrs()", () => {
    const { code } = compileAstro("<a {...rest}></a>");
    expect(code).toContain("$$out += $$result.attrs(rest)");
  });

  it("emits components as $$result.renderComponent() calls", () => {
    const { code } = compileAstro("<Card title={t} />");
    expect(code).toMatch(/\$\$result\.renderComponent\(Card, \{ title: \(t\) \}, \{\}\)/);
  });

  it("captures component children in a default slot function", () => {
    const { code } = compileAstro("<Card>hello {name}</Card>");
    expect(code).toContain("default: async () =>");
    expect(code).toContain("$$result.escape(name)");
  });

  it('groups children by slot="<name>" attribute on top-level elements', () => {
    const { code } = compileAstro('<Layout><h1>Title</h1><p slot="footer">©</p></Layout>');
    expect(code).toMatch(/default: async/);
    expect(code).toMatch(/footer: async/);
  });

  it("renders <slot /> as $$result.renderSlot()", () => {
    const { code } = compileAstro("<slot />");
    expect(code).toContain('$$result.renderSlot($$slots, "default", undefined)');
  });

  it("renders named slots with their fallback content", () => {
    const { code } = compileAstro('<slot name="footer">©</slot>');
    expect(code).toContain('$$result.renderSlot($$slots, "footer",');
    // Fallback compiled inline as a function expression
    expect(code).toContain("async () => {");
  });

  it("set:html bypasses escaping for the value, but not the surrounding tags", () => {
    const { code } = compileAstro("<div set:html={raw}></div>");
    expect(code).toContain('String(raw ?? "")');
    expect(code).not.toContain("$$result.escape(raw)");
  });

  it("emits raw <style> contents verbatim", () => {
    const { code } = compileAstro("<style>h1 { color: red; }</style>");
    expect(code).toContain('$$out += "h1 { color: red; }"');
  });
});
