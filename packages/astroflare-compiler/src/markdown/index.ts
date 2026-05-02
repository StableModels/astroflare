/**
 * `.md` compiler.
 *
 * Compiles Markdown source into the same Astroflare component ABI shape the
 * `.astro` compiler produces (default-exporting `$component`). The user gets:
 *   - frontmatter as `Astro.props.frontmatter` (a plain object parsed from
 *     the YAML block at the top of the file)
 *   - the rendered HTML as the component's body
 *
 * Phase 6 minimum (per §3 Tier 1 of the brief):
 *   - YAML frontmatter
 *   - basic Markdown via `unified` + `remark-parse` + `remark-rehype` +
 *     `rehype-stringify`. No remark/rehype plugins yet (each is opt-in via
 *     `astroflare.config.ts#markdown.remarkPlugins`/`rehypePlugins` once we
 *     wire config plumbing).
 *
 * Phase 6 carve-outs (in retro):
 *   - MDX (full JSX-in-markdown) — uses `@mdx-js/mdx`. Substantively bigger
 *     than basic MD; deferred.
 *   - Shiki syntax highlighting — pure JS but ~5 MB of bundled grammars; the
 *     framework should accept a `rehype-shiki`-shaped plugin in config.
 *   - User-supplied remark/rehype plugin chains — the schema exists in
 *     `AstroflareConfig.markdown` but we don't yet thread it into the
 *     compiler.
 *   - Slugged headings, automatic table-of-contents — common Astro features
 *     but plugin-driven, so they ride on the plugin chain wiring.
 */

import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";

const RUNTIME_SYMBOLS = ["$component", "$render", "$rawHtml"] as const;

const DEFAULT_RUNTIME_IMPORT = "@astroflare/runtime/internal";

export interface MarkdownCompileOptions {
	/** Module specifier for the runtime ABI (default `@astroflare/runtime/internal`). */
	runtimeImport?: string;
	/** Source filename for error messages. */
	filename?: string;
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

	// 2. Compile Markdown body to HTML.
	const html = String(
		await unified()
			.use(remarkParse)
			.use(remarkRehype, { allowDangerousHtml: true })
			.use(rehypeStringify, { allowDangerousHtml: true })
			.process(body),
	);

	// 3. Emit ESM. Frontmatter is a local `const` (not a named export) so it
	//    survives the inline bundler's IIFE wrapping — see `bundle.ts`. Astro's
	//    common pattern of `import { frontmatter } from "./post.md"` (named
	//    import from another `.md`) isn't yet supported; users get frontmatter
	//    via `Astro.props.frontmatter` instead. Documented as a Phase 6
	//    carve-out; the inline bundler would need to hoist named exports
	//    cross-module, which is bundler-grade work.
	const code = [
		`import { ${RUNTIME_SYMBOLS.join(", ")} } from ${JSON.stringify(runtimeImport)};`,
		`const frontmatter = ${JSON.stringify(frontmatter)};`,
		`const __html = ${JSON.stringify(html)};`,
		"export default $component(async ({ Astro, ...$$props }, $$slots) => {",
		"  Astro.props.frontmatter = frontmatter;",
		"  return $render`${$rawHtml(__html)}`;",
		"});",
		"",
	].join("\n");

	return { code, frontmatter, html };
}
