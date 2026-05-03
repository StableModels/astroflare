import { describe, expect, it } from "vitest";
import { compileMarkdown } from "../markdown/index.js";
import { compileMdx } from "../mdx/index.js";

describe("Shiki: integration with compileMarkdown", () => {
	it("highlights a fenced code block", async () => {
		const src = "Code:\n\n```javascript\nconst x = 1;\n```\n";
		const r = await compileMarkdown(src);
		// Shiki always emits inline `style="color:#…"` spans; the original
		// `<pre><code class="language-javascript">` is replaced.
		expect(r.html).toMatch(/<pre[^>]*class="shiki/);
		expect(r.html).toContain('style="color:');
		// Original `language-` class no longer present in <code>
		expect(r.html).not.toContain('class="language-javascript"');
	});

	it("falls back to plaintext for unknown languages", async () => {
		const src = "```not-a-real-language\nfoo\n```\n";
		const r = await compileMarkdown(src);
		// Plaintext still produces a <pre class="shiki ..."> wrapper.
		expect(r.html).toMatch(/<pre[^>]*class="shiki/);
		expect(r.html).toContain("foo");
	});

	it("can be disabled via shiki: false", async () => {
		const src = "```javascript\nconst x = 1;\n```\n";
		const r = await compileMarkdown(src, { shiki: false });
		// Without Shiki, remark-rehype emits the bare `<pre><code class=…>`
		// pair.
		expect(r.html).toContain('<code class="language-javascript">');
		expect(r.html).not.toContain('class="shiki');
	});

	it("leaves prose untouched", async () => {
		const src = "# Heading\n\nplain paragraph.\n";
		const r = await compileMarkdown(src);
		expect(r.html).toContain("<h1>Heading</h1>");
		expect(r.html).toContain("<p>plain paragraph.</p>");
	});

	it("highlights multiple languages in one document", async () => {
		const src =
			"## a\n\n```typescript\nconst a: number = 1;\n```\n\n" +
			"## b\n\n```css\n.x { color: red; }\n```\n";
		const r = await compileMarkdown(src);
		// Two highlighted blocks → two `<pre class="shiki ...">` wrappers.
		const matches = r.html.match(/<pre[^>]*class="shiki/g) ?? [];
		expect(matches.length).toBe(2);
	});
});

describe("Shiki: integration with compileMdx", () => {
	it("highlights fenced code blocks inside .mdx", async () => {
		const src = "# Title\n\n```javascript\nconst x = 1;\n```\n";
		const r = await compileMdx(src);
		// MDX compiles to JSX, so Shiki's HTML lives inside _jsx calls.
		// We can verify by spotting Shiki's signature in the emitted code.
		expect(r.code).toContain("shiki");
		expect(r.code).toContain("color:");
	});

	it("can be disabled via shiki: false in MDX", async () => {
		const src = "```javascript\nconst x = 1;\n```\n";
		const r = await compileMdx(src, { shiki: false });
		expect(r.code).not.toContain("shiki");
	});
});
