import { describe, expect, it } from "vitest";
import { AstroParseError, parseAstro } from "../src/index.js";

describe("parseAstro — frontmatter", () => {
  it("parses a frontmatter block followed by a body", () => {
    const doc = parseAstro("---\nconst x = 1;\n---\n<h1>{x}</h1>");
    expect(doc.frontmatter).not.toBeNull();
    expect(doc.frontmatter!.code).toBe("const x = 1;\n");
    expect(doc.body).toHaveLength(1);
    expect(doc.body[0]!.kind).toBe("element");
  });

  it("handles a missing frontmatter (body only)", () => {
    const doc = parseAstro("<h1>hi</h1>");
    expect(doc.frontmatter).toBeNull();
    expect(doc.body).toHaveLength(1);
  });

  it("treats `---` not at line start as text, not as frontmatter", () => {
    const doc = parseAstro("<p>---hello---</p>");
    expect(doc.frontmatter).toBeNull();
  });

  it("throws with line/column on an unterminated frontmatter", () => {
    let caught: AstroParseError | null = null;
    try {
      parseAstro("---\nconst x = 1;\n");
    } catch (e) {
      caught = e as AstroParseError;
    }
    expect(caught).toBeInstanceOf(AstroParseError);
    expect(caught!.message).toMatch(/unterminated frontmatter/);
    expect(caught!.position.line).toBe(1);
  });
});

describe("parseAstro — elements", () => {
  it("parses a self-closing void element", () => {
    const doc = parseAstro("<br>");
    const node = doc.body[0]!;
    expect(node.kind).toBe("element");
    if (node.kind !== "element") throw new Error("not an element");
    expect(node.tag).toBe("br");
    expect(node.children).toEqual([]);
  });

  it("parses a self-closing slash element", () => {
    const doc = parseAstro('<input type="text" />');
    const node = doc.body[0]!;
    if (node.kind !== "element") throw new Error("not an element");
    expect(node.selfClosing).toBe(true);
    expect(node.attributes).toHaveLength(1);
  });

  it("parses an open/close pair with text children", () => {
    const doc = parseAstro("<p>hello <strong>world</strong>!</p>");
    const node = doc.body[0]!;
    if (node.kind !== "element") throw new Error("not an element");
    expect(node.tag).toBe("p");
    expect(node.children).toHaveLength(3);
  });

  it("recognises capitalised tags as components", () => {
    const doc = parseAstro("<Layout><h1>Hi</h1></Layout>");
    const node = doc.body[0]!;
    expect(node.kind).toBe("component");
    if (node.kind !== "component") throw new Error("not a component");
    expect(node.tag).toBe("Layout");
    expect(node.children).toHaveLength(1);
  });

  it("recognises member-access tags as components (Foo.Bar)", () => {
    const doc = parseAstro("<Foo.Bar />");
    const node = doc.body[0]!;
    expect(node.kind).toBe("component");
  });

  it("parses DOCTYPE as a doctype node", () => {
    const doc = parseAstro("<!DOCTYPE html><html></html>");
    expect(doc.body[0]!.kind).toBe("doctype");
    expect(doc.body[1]!.kind).toBe("element");
  });

  it("parses HTML comments", () => {
    const doc = parseAstro("<!-- hello --><p>x</p>");
    expect(doc.body[0]!.kind).toBe("comment");
    if (doc.body[0]!.kind !== "comment") throw new Error("not a comment");
    expect(doc.body[0]!.value).toBe(" hello ");
  });
});

describe("parseAstro — attributes", () => {
  it("parses static, expression, shorthand, spread, and boolean attributes", () => {
    const doc = parseAstro(`<input type="text" name={n} {value} {...rest} disabled>`);
    const node = doc.body[0]!;
    if (node.kind !== "element") throw new Error("not an element");
    expect(node.attributes.map((a) => a.kind)).toEqual([
      "static",
      "expression",
      "shorthand",
      "spread",
      "boolean",
    ]);
  });

  it("parses single-quoted, double-quoted, and unquoted values", () => {
    const doc = parseAstro(`<link href="x" title='y' rel=stylesheet>`);
    const node = doc.body[0]!;
    if (node.kind !== "element") throw new Error("not an element");
    const [a, b, c] = node.attributes;
    expect(a).toMatchObject({ kind: "static", value: "x", quote: '"' });
    expect(b).toMatchObject({ kind: "static", value: "y", quote: "'" });
    expect(c).toMatchObject({ kind: "static", value: "stylesheet", quote: null });
  });

  it("preserves directive-style attribute names like set:html", () => {
    const doc = parseAstro("<div set:html={raw}></div>");
    const node = doc.body[0]!;
    if (node.kind !== "element") throw new Error("not an element");
    expect(node.attributes[0]).toMatchObject({ kind: "expression", name: "set:html" });
  });
});

describe("parseAstro — interpolations", () => {
  it("captures a simple expression", () => {
    const doc = parseAstro("<p>{x + 1}</p>");
    const p = doc.body[0]!;
    if (p.kind !== "element") throw new Error("not an element");
    expect(p.children[0]).toMatchObject({ kind: "interpolation", expression: "x + 1" });
  });

  it("balances nested braces inside expressions", () => {
    const doc = parseAstro("<p>{ ({a:1, b:{c:2}}).a }</p>");
    const p = doc.body[0]!;
    if (p.kind !== "element") throw new Error("not an element");
    expect(p.children[0]).toMatchObject({
      kind: "interpolation",
      expression: " ({a:1, b:{c:2}}).a ",
    });
  });

  it("respects strings, template literals, and comments inside expressions", () => {
    const doc = parseAstro(
      "<p>{ /* { not a brace */ `inner ${'}}}'} done` + \"a}b\" + 'x}y' }</p>",
    );
    const p = doc.body[0]!;
    if (p.kind !== "element") throw new Error("not an element");
    expect(p.children[0]!.kind).toBe("interpolation");
  });

  it("throws on an unterminated expression", () => {
    let caught: AstroParseError | null = null;
    try {
      parseAstro("<p>{ 1 + 2 </p>");
    } catch (e) {
      caught = e as AstroParseError;
    }
    expect(caught).toBeInstanceOf(AstroParseError);
    expect(caught!.message).toMatch(/unterminated expression/);
  });
});

describe("parseAstro — slots", () => {
  it("parses a default slot", () => {
    const doc = parseAstro("<slot />");
    const node = doc.body[0]!;
    expect(node.kind).toBe("slot");
    if (node.kind !== "slot") throw new Error();
    expect(node.name).toBe("default");
  });

  it("parses a named slot with fallback content", () => {
    const doc = parseAstro('<slot name="footer">©</slot>');
    const node = doc.body[0]!;
    if (node.kind !== "slot") throw new Error();
    expect(node.name).toBe("footer");
    expect(node.fallback).toHaveLength(1);
  });
});

describe("parseAstro — raw blocks", () => {
  it("captures <style> contents verbatim", () => {
    const doc = parseAstro("<style>h1 { color: red; }</style>");
    const node = doc.body[0]!;
    expect(node.kind).toBe("raw-element");
    if (node.kind !== "raw-element") throw new Error();
    expect(node.tag).toBe("style");
    expect(node.raw).toBe("h1 { color: red; }");
  });

  it("captures <script> contents verbatim, including '<' and '{'", () => {
    const doc = parseAstro("<script>const a = 1 < 2; const b = {x: 1};</script>");
    const node = doc.body[0]!;
    if (node.kind !== "raw-element") throw new Error();
    expect(node.raw).toBe("const a = 1 < 2; const b = {x: 1};");
  });
});

describe("parseAstro — error positions", () => {
  it("reports an unterminated tag at the right line", () => {
    let caught: AstroParseError | null = null;
    try {
      parseAstro("<p>\n  hello\n");
    } catch (e) {
      caught = e as AstroParseError;
    }
    expect(caught).toBeInstanceOf(AstroParseError);
    expect(caught!.message).toMatch(/unterminated element/);
  });

  it("includes a snippet pointing at the column", () => {
    let caught: AstroParseError | null = null;
    try {
      parseAstro("<p attr=>");
    } catch (e) {
      caught = e as AstroParseError;
    }
    expect(caught!.snippet).toContain("^");
  });
});
