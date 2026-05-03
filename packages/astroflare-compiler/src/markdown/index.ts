/**
 * `.md` compiler.
 *
 * Compiles Markdown source into the same Astroflare component ABI shape the
 * `.astro` compiler produces (default-exporting `$component`). The user gets:
 *   - frontmatter as `Astro.props.frontmatter` (a plain object parsed from
 *     the YAML block at the top of the file). Phase 14 also exposes it as
 *     a top-level `export const frontmatter` so other modules can `import
 *     { frontmatter } from "./post.md"`.
 *   - the rendered HTML as the component's body
 *   - Shiki syntax highlighting on every fenced code block (Phase 14 — the
 *     one opinionated default, not user-pluggable for now).
 *
 * Carve-outs (in retro):
 *   - User-supplied remark/rehype plugin chains — the schema exists in
 *     `AstroflareConfig.markdown` but we don't yet thread it into the
 *     compiler. Phase 14 deliberately deferred this until real demand
 *     surfaces; Shiki rides as the one default and nothing else.
 *   - Slugged headings, automatic table-of-contents — common Astro
 *     features but plugin-driven, so they ride on the plugin chain
 *     wiring.
 */

import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type Plugin, unified } from "unified";
import { parse as parseYaml } from "yaml";
import { rehypeShiki } from "../shiki/index.js";

const RUNTIME_SYMBOLS = ["$component", "$render", "$rawHtml"] as const;

const DEFAULT_RUNTIME_IMPORT = "@astroflare/runtime/internal";

export interface MarkdownCompileOptions {
	/** Module specifier for the runtime ABI (default `@astroflare/runtime/internal`). */
	runtimeImport?: string;
	/** Source filename for error messages. */
	filename?: string;
	/** Disable Shiki syntax highlighting (default: enabled — Phase 14). */
	shiki?: false;
	/** Extra rehype plugins. Internal — reserved for future config plumbing. */
	rehypePlugins?: Plugin[];
}

export interface MarkdownCompileResult {
	code: string;
	frontmatter: Record<string, unknown>;
	html: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Compile a Markdown source string into ESM that default-exports an
 * Astroflare component. The component renders the parsed HTML body and
 * exposes the frontmatter via `Astro.props.frontmatter`.
 */
export async function compileMarkdown(
	source: string,
	opts: MarkdownCompileOptions = {},
): Promise<MarkdownCompileResult> {
	const runtimeImport = opts.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;

	// 1. Pull out the YAML frontmatter, if any.
	let frontmatter: Record<string, unknown> = {};
	let body = source;
	const fmMatch = FRONTMATTER_RE.exec(source);
	if (fmMatch) {
		const yamlText = fmMatch[1] as string;
		try {
			const parsed = parseYaml(yamlText);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				frontmatter = parsed as Record<string, unknown>;
			}
		} catch (err) {
			throw new Error(
				`markdown: invalid YAML frontmatter${
					opts.filename ? ` in ${opts.filename}` : ""
				}: ${(err as Error).message}`,
			);
		}
		body = source.slice(fmMatch[0].length);
	}

	// 2. Compile Markdown body to HTML. Shiki sits between remark-rehype
	//    and rehype-stringify so its `<pre><span style="color:#…">…` output
	//    survives stringification (the `raw` hast nodes flow through
	//    rehype-stringify because `allowDangerousHtml` is on).
	const processor = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true });
	if (opts.shiki !== false) {
		processor.use(rehypeShiki());
	}
	for (const p of opts.rehypePlugins ?? []) {
		processor.use(p);
	}
	const html = String(
		await processor.use(rehypeStringify, { allowDangerousHtml: true }).process(body),
	);

	// 3. Emit ESM. Frontmatter is a top-level *named* export so other modules
	//    can `import { frontmatter } from "./post.md"` and consume it
	//    (Astro's common pattern for blog index pages). The inline bundler
	//    threads each module's named exports through its IIFE return object
	//    and rewrites cross-module named imports against that — see
	//    `bundle.ts` for the cross-module hoisting machinery added in
	//    Phase 14.
	const code = [
		`import { ${RUNTIME_SYMBOLS.join(", ")} } from ${JSON.stringify(runtimeImport)};`,
		`export const frontmatter = ${JSON.stringify(frontmatter)};`,
		`const __html = ${JSON.stringify(html)};`,
		"export default $component(async ({ Astro, ...$$props }, $$slots) => {",
		"  Astro.props.frontmatter = frontmatter;",
		"  return $render`${$rawHtml(__html)}`;",
		"});",
		"",
	].join("\n");

	return { code, frontmatter, html };
}
