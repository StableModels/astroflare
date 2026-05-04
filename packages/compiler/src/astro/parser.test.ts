import { describe, expect, it } from "vitest";
import type { AstroComponent, AstroElement, AstroNode, AstroSlot } from "./ast.js";
import { parseAstro } from "./parser.js";

const parse = (s: string) => parseAstro(s);

const expectNoErrors = (r: ReturnType<typeof parse>) => {
	if (r.errors.length > 0) {
		throw new Error(`unexpected errors: ${JSON.stringify(r.errors, null, 2)}`);
	}
};

describe("parser — frontmatter", () => {
	it("captures frontmatter between `---` markers", () => {
		const r = parse("---\nconst x = 1;\n---\n<p>hi</p>");
		expectNoErrors(r);
		expect(r.doc.frontmatter).toBe("const x = 1;\n");
		// The newline after the closing `---` is consumed; body starts at `<p>`.
		expect(r.doc.body).toHaveLength(1);
		expect(r.doc.body[0]).toMatchObject({ type: "element", name: "p" });
	});

	it("treats absent frontmatter as null (not the empty string)", () => {
		const r = parse("<p>hi</p>");
		expectNoErrors(r);
		expect(r.doc.frontmatter).toBeNull();
	});

	it("does not mistake `---` mid-document for frontmatter", () => {
		const r = parse("<p>hello</p>\n---\nnot frontmatter");
		expectNoErrors(r);
		expect(r.doc.frontmatter).toBeNull();
	});

	it("reports an error for unclosed frontmatter", () => {
		const r = parse("---\nconst x = 1;\n");
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]?.message).toMatch(/Unclosed frontmatter/);
	});

	it("tolerates leading blank lines before frontmatter", () => {
		const r = parse("\n\n---\nx\n---\n<p />");
		expectNoErrors(r);
		expect(r.doc.frontmatter).toBe("x\n");
	});
});

describe("parser — text and expressions", () => {
	it("parses bare text", () => {
		const r = parse("hello");
		expectNoErrors(r);
		expect(r.doc.body).toEqual([expect.objectContaining({ type: "text", value: "hello" })]);
	});

	it("parses a content expression", () => {
		const r = parse("hello {name}!");
		expectNoErrors(r);
		expect(r.doc.body[0]).toMatchObject({ type: "text", value: "hello " });
		expect(r.doc.body[1]).toMatchObject({ type: "expression", expression: "name" });
		expect(r.doc.body[2]).toMatchObject({ type: "text", value: "!" });
	});

	it("balances braces inside expressions through strings and comments", () => {
		const src = "{x === '}' /* } */ ? `${1+1}` : { a: 1 }}";
		const r = parse(src);
		expectNoErrors(r);
		expect(r.doc.body[0]).toMatchObject({ type: "expression" });
		expect((r.doc.body[0] as { expression: string }).expression).toBe(
			"x === '}' /* } */ ? `${1+1}` : { a: 1 }",
		);
	});

	it("reports unclosed expression with source position", () => {
		const r = parse("hello {name");
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]?.message).toMatch(/Unclosed expression/);
		expect(r.errors[0]?.start.line).toBe(1);
	});

	// Regex literal disambiguation (Phase 11). Without it, a `}` inside a
	// regex character class would close the expression early.
	it("treats /[}]/ as a regex, not a division of `[}]`", () => {
		const r = parse("{'abc'.match(/[}]/)}");
		expectNoErrors(r);
		expect((r.doc.body[0] as { expression: string }).expression).toBe("'abc'.match(/[}]/)");
	});

	it("recognises a regex after `return` keyword", () => {
		const r = parse("{(() => { return /^[a-z]+$/.test('x') })()}");
		expectNoErrors(r);
	});

	it("treats `/` after a value-like token as division", () => {
		// `a/b` is division, not a regex. The `}` after `b` ends the expr.
		const r = parse("{a/b}");
		expectNoErrors(r);
		expect((r.doc.body[0] as { expression: string }).expression).toBe("a/b");
	});

	it("recognises a regex with flags", () => {
		const r = parse("{x.match(/foo/gi)}");
		expectNoErrors(r);
		expect((r.doc.body[0] as { expression: string }).expression).toBe("x.match(/foo/gi)");
	});

	it("regex containing escaped slash doesn't terminate early", () => {
		const r = parse("{x.match(/a\\/b/)}");
		expectNoErrors(r);
		expect((r.doc.body[0] as { expression: string }).expression).toBe("x.match(/a\\/b/)");
	});
});

// Regression: the brace scanner used to mistake the `/` in a JSX
// closing tag (`</li>`) for a regex literal because the previous
// non-whitespace token was `<`, which the JS regex/division heuristic
// classifies as "value expected next." That ran the regex skipper off
// the end of the source and surfaced as `Unclosed expression (missing
// `}`)` — blocking the canonical `.map((x) => (<li>...</li>))` idiom.
describe("parser — JSX in content expressions", () => {
	it("balances braces around `.map` arrow returning JSX", () => {
		const src = `---
const items = ["a", "b"];
---
<ul>{items.map((x) => (<li>{x}</li>))}</ul>`;
		const r = parse(src);
		expectNoErrors(r);
	});

	it("balances braces around nested JSX with attribute expressions", () => {
		const src = `---
const posts = [{ slug: "foo", title: "bar" }];
---
<div>{posts.map((p) => (<a href={p.slug}>{p.title}</a>))}</div>`;
		const r = parse(src);
		expectNoErrors(r);
	});

	it("balances braces around a ternary returning two JSX branches", () => {
		const src = `---
const open = true;
---
<div>{open ? (<details>open</details>) : (<summary>closed</summary>)}</div>`;
		const r = parse(src);
		expectNoErrors(r);
	});

	it("balances braces around self-closing JSX inside an expression", () => {
		const src = `---
const items = [1,2,3];
---
<ul>{items.map((n) => (<img src="/x.png" alt={n} />))}</ul>`;
		const r = parse(src);
		expectNoErrors(r);
	});

	it("still recognises a real regex literal after the JSX-tag guard", () => {
		// Sanity: the new short-circuit only fires when `/` is glued to
		// `<` or `>`. Regexes preceded by other expression-position
		// tokens (here `(`) must keep working.
		const r = parse("{'abc'.match(/foo/g)}");
		expectNoErrors(r);
		expect((r.doc.body[0] as { expression: string }).expression).toBe("'abc'.match(/foo/g)");
	});

	it("still parses comparison `>` followed by a non-JSX expression", () => {
		const src = `---
const x = 5;
---
<p>{x > 3 ? "big" : "small"}</p>`;
		const r = parse(src);
		expectNoErrors(r);
	});

	it("still parses `a < /pattern/.test(s)` (whitespace between `<` and `/`)", () => {
		// The JSX guard is intentionally adjacency-sensitive: only `</`
		// and `>/` (no whitespace) short-circuit. Conventional JS that
		// puts a space between the comparison operator and the regex
		// literal continues to parse as comparison + regex.
		const r = parse("{a < /foo/.test(s)}");
		expectNoErrors(r);
		expect((r.doc.body[0] as { expression: string }).expression).toBe("a < /foo/.test(s)");
	});
});

describe("parser — HTML elements", () => {
	it("parses a self-closing void element with a static attribute", () => {
		const r = parse('<input type="text" disabled />');
		expectNoErrors(r);
		const el = r.doc.body[0] as AstroElement;
		expect(el.type).toBe("element");
		expect(el.name).toBe("input");
		expect(el.attrs).toHaveLength(2);
		expect(el.attrs[0]).toMatchObject({ type: "static", name: "type", value: "text" });
		expect(el.attrs[1]).toMatchObject({
			type: "static",
			name: "disabled",
			boolean: true,
		});
	});

	it("parses single-quoted attribute values", () => {
		const r = parse("<a href='/x'>link</a>");
		expectNoErrors(r);
		const el = r.doc.body[0] as AstroElement;
		expect(el.attrs[0]).toMatchObject({ name: "href", value: "/x" });
	});

	it("parses unquoted attribute values", () => {
		const r = parse("<a href=/about>x</a>");
		expectNoErrors(r);
		const el = r.doc.body[0] as AstroElement;
		expect(el.attrs[0]).toMatchObject({ name: "href", value: "/about" });
	});

	it("parses an expression attribute", () => {
		const r = parse("<a href={url}>x</a>");
		expectNoErrors(r);
		const el = r.doc.body[0] as AstroElement;
		expect(el.attrs[0]).toMatchObject({
			type: "expression",
			name: "href",
			expression: "url",
		});
	});

	it("parses spread attributes", () => {
		const r = parse("<div {...rest}>x</div>");
		expectNoErrors(r);
		const el = r.doc.body[0] as AstroElement;
		expect(el.attrs[0]).toMatchObject({ type: "spread", expression: "rest" });
	});

	it("parses shorthand attributes `{name}`", () => {
		const r = parse("<input {value} />");
		expectNoErrors(r);
		const el = r.doc.body[0] as AstroElement;
		expect(el.attrs[0]).toMatchObject({
			type: "shorthand",
			name: "value",
			expression: "value",
		});
	});

	it("treats void HTML elements as self-closing without `/>`", () => {
		const r = parse("<br>after");
		expectNoErrors(r);
		expect(r.doc.body).toHaveLength(2);
		expect(r.doc.body[0]).toMatchObject({ type: "element", name: "br", children: [] });
	});

	it("parses nested elements", () => {
		const r = parse("<ul><li>a</li><li>b</li></ul>");
		expectNoErrors(r);
		const ul = r.doc.body[0] as AstroElement;
		expect(ul.name).toBe("ul");
		expect(ul.children).toHaveLength(2);
		expect((ul.children[0] as AstroElement).name).toBe("li");
		expect((ul.children[0] as AstroElement).children[0]).toMatchObject({
			type: "text",
			value: "a",
		});
	});

	it("reports an unclosed tag", () => {
		const r = parse("<div><p>");
		expect(r.errors.length).toBeGreaterThanOrEqual(1);
		expect(r.errors[0]?.message).toMatch(/Unclosed tag/);
	});
});

describe("parser — components", () => {
	it("classifies uppercase tags as components", () => {
		const r = parse('<Layout title="X">child</Layout>');
		expectNoErrors(r);
		const c = r.doc.body[0] as AstroComponent;
		expect(c.type).toBe("component");
		expect(c.name).toBe("Layout");
		expect(c.attrs).toHaveLength(1);
		expect(c.children[0]).toMatchObject({ type: "text", value: "child" });
	});

	it("classifies dotted tags (Foo.Bar) as components", () => {
		const r = parse("<UI.Button label='Hi' />");
		expectNoErrors(r);
		const c = r.doc.body[0] as AstroComponent;
		expect(c.type).toBe("component");
		expect(c.name).toBe("UI.Button");
		expect(c.selfClosing).toBe(true);
	});

	it('captures slot="name" on component children', () => {
		const r = parse('<Layout><p slot="aside">side</p><p>main</p></Layout>');
		expectNoErrors(r);
		const c = r.doc.body[0] as AstroComponent;
		const aside = c.children[0] as AstroElement;
		expect(aside.attrs.find((a) => a.type === "static" && a.name === "slot")).toMatchObject({
			value: "aside",
		});
	});
});

describe("parser — slots", () => {
	it("parses default slot", () => {
		const r = parse("<slot />");
		expectNoErrors(r);
		const s = r.doc.body[0] as AstroSlot;
		expect(s.type).toBe("slot");
		expect(s.name).toBe("default");
	});

	it("parses named slot", () => {
		const r = parse('<slot name="header" />');
		expectNoErrors(r);
		const s = r.doc.body[0] as AstroSlot;
		expect(s.name).toBe("header");
	});

	it("parses slot fallback content", () => {
		const r = parse("<slot>fallback</slot>");
		expectNoErrors(r);
		const s = r.doc.body[0] as AstroSlot;
		expect(s.children[0]).toMatchObject({ type: "text", value: "fallback" });
	});
});

describe("parser — directives", () => {
	it("parses `set:html={expr}`", () => {
		const r = parse("<div set:html={raw} />");
		expectNoErrors(r);
		const el = r.doc.body[0] as AstroElement;
		expect(el.attrs[0]).toMatchObject({
			type: "directive",
			name: "set:html",
			expression: "raw",
		});
	});

	it("parses `is:raw` (boolean directive)", () => {
		const r = parse("<pre is:raw>literal {expr}</pre>");
		expectNoErrors(r);
		const el = r.doc.body[0] as AstroElement;
		expect(el.attrs[0]).toMatchObject({
			type: "directive",
			name: "is:raw",
			expression: null,
		});
	});

	it("parses `define:vars={obj}`", () => {
		const r = parse("<script define:vars={{ user }}>console.log(user)</script>");
		expectNoErrors(r);
		const el = r.doc.body[0] as AstroElement;
		expect(el.attrs[0]).toMatchObject({
			type: "directive",
			name: "define:vars",
			expression: "{ user }",
		});
	});

	it("parses `client:visible`, `client:load`, etc.", () => {
		const r = parse("<Counter client:load />");
		expectNoErrors(r);
		const c = r.doc.body[0] as AstroComponent;
		expect(c.attrs[0]).toMatchObject({
			type: "directive",
			name: "client:load",
			expression: null,
		});
	});

	it('parses `client:media="..."`', () => {
		const r = parse('<Counter client:media="(max-width: 600px)" />');
		expectNoErrors(r);
		const c = r.doc.body[0] as AstroComponent;
		expect(c.attrs[0]).toMatchObject({
			type: "directive",
			name: "client:media",
		});
	});
});

describe("parser — comments and doctypes", () => {
	it("parses HTML comments", () => {
		const r = parse("<!-- TODO --><p>x</p>");
		expectNoErrors(r);
		expect(r.doc.body[0]).toMatchObject({ type: "comment", value: " TODO " });
	});

	it("parses HTML5 doctype", () => {
		const r = parse("<!doctype html>\n<p>x</p>");
		expectNoErrors(r);
		expect(r.doc.body[0]).toMatchObject({ type: "doctype", value: "html" });
	});

	it("reports unclosed comment", () => {
		const r = parse("<!-- never ending");
		expect(r.errors[0]?.message).toMatch(/Unclosed HTML comment/);
	});
});

describe("parser — fragments", () => {
	it("parses <Fragment>...</Fragment>", () => {
		const r = parse("<Fragment><p>a</p><p>b</p></Fragment>");
		expectNoErrors(r);
		expect(r.doc.body[0]).toMatchObject({ type: "fragment" });
		expect((r.doc.body[0] as AstroNode & { children: AstroNode[] }).children).toHaveLength(2);
	});

	it("parses <>...</> shorthand", () => {
		const r = parse("<><p>a</p></>");
		expectNoErrors(r);
		expect(r.doc.body[0]).toMatchObject({ type: "fragment" });
	});
});

describe("parser — error positions", () => {
	it("reports line and column for an unclosed expression", () => {
		const r = parse("\n<p>{name</p>");
		expect(r.errors[0]?.start.line).toBe(2);
		// `<p>` is at column 1; `{` is at column 4.
		expect(r.errors[0]?.start.column).toBe(4);
	});
});

describe("parser — components named after HTML void elements", () => {
	// Regression: components whose name lower-cases to an HTML void element
	// (`<base>`, `<img>`, `<br>`, `<link>`, `<meta>`, etc.) used to be
	// classified as void and have their children promoted to siblings,
	// emitting a stray `</Component>` text node and a parse error.
	const VOID_LIKE_NAMES = ["Base", "Img", "Br", "Link", "Meta", "Hr", "Input"];

	for (const name of VOID_LIKE_NAMES) {
		it(`<${name}>...</${name}> parses with children, not as void`, () => {
			const r = parse(`<${name}><h1>x</h1></${name}>`);
			expectNoErrors(r);
			const top = r.doc.body[0] as AstroComponent;
			expect(top.type).toBe("component");
			expect(top.name).toBe(name);
			expect(top.selfClosing).toBe(false);
			expect(top.children).toHaveLength(1);
			expect((top.children[0] as AstroElement).name).toBe("h1");
		});
	}

	it("HTML <base> stays void", () => {
		const r = parse('<base href="/"><p>after</p>');
		expectNoErrors(r);
		const baseEl = r.doc.body[0] as AstroElement;
		expect(baseEl.type).toBe("element");
		expect(baseEl.name).toBe("base");
		expect(baseEl.selfClosing).toBe(true);
		// `<p>after</p>` is a sibling, not a child of <base>.
		expect(r.doc.body[1]).toMatchObject({ type: "element", name: "p" });
	});
});
