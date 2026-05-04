/**
 * Shiki — opt-in syntax highlighter for fenced code blocks.
 *
 * Both `compileMarkdown` and `compileMdx` thread this rehype plugin into
 * their unified pipelines when highlighting is enabled. The plugin walks
 * the hast tree, finds every `<pre><code class="language-…">` produced
 * by remark-rehype, and replaces the pair with Shiki's highlighted HTML
 * embedded as a `raw` hast node.
 *
 * Why "raw" nodes:
 *   - For `.md`: rehype-stringify already runs with `allowDangerousHtml:
 *     true` (so embedded HTML in markdown survives). Raw nodes pass
 *     through unchanged.
 *   - For `.mdx`: `@mdx-js/mdx` converts hast → estree via
 *     `hast-util-to-estree`, which re-parses raw HTML through
 *     `hast-util-raw` and emits proper JSX. Same result; different
 *     route.
 *
 * Single shared highlighter, cached at module scope. First call pays the
 * grammar/theme load (~100 ms); subsequent calls are fast.
 *
 * ## Cloudflare Workers compatibility (HARD RULE)
 *
 * Astroflare only ships paths that run on a Cloudflare Worker. Shiki's
 * default Oniguruma regex engine fails that bar — it dynamically
 * imports `shiki/wasm` and instantiates it at runtime, which Workers
 * blocks (`Wasm code generation disallowed by embedder`). We
 * therefore wire `createJavaScriptRegexEngine()` unconditionally; the
 * Oniguruma path is not exposed.
 *
 * Carve-outs:
 *   - One default theme (`github-dark`) — no per-block theme override.
 *   - Default language allowlist focused on web work; uncommon languages
 *     fall back to `plaintext`. The set covers what `withastro/astro`'s
 *     example fixtures actually use.
 *   - No transformers, no diff/notation handling.
 */

import type { Element, Root } from "hast";
import { type Highlighter, type ShikiTransformer, createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { Plugin } from "unified";

const DEFAULT_THEME = "github-dark";

/**
 * Languages preloaded into the highlighter. Uncommon languages fall back
 * to `plaintext` at highlight time. The set is deliberately narrow — every
 * language adds startup time and bundle size.
 */
const DEFAULT_LANGS = [
	"javascript",
	"typescript",
	"jsx",
	"tsx",
	"json",
	"html",
	"css",
	"markdown",
	"mdx",
	"bash",
	"shell",
	"yaml",
	"toml",
	"plaintext",
] as const;

let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Get (or lazily create) the process-wide highlighter. Always uses the
 * pure-JS regex engine — see the "Cloudflare Workers compatibility"
 * note at the top of this file.
 */
async function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: [DEFAULT_THEME],
			langs: [...DEFAULT_LANGS],
			engine: createJavaScriptRegexEngine(),
		});
	}
	return highlighterPromise;
}

interface ShikiOptions {
	/** Override the default theme. Mostly for tests. */
	theme?: string;
	/** Optional transformers (Shiki's per-line / per-token hooks). */
	transformers?: ShikiTransformer[];
}

/**
 * Rehype plugin: replace every `<pre><code class="language-…">…</code></pre>`
 * with Shiki's highlighted HTML.
 *
 * Returns a unified `Plugin` so both `compileMarkdown` (which has its own
 * rehype-stringify pipeline) and `compileMdx` (which feeds rehype output to
 * `hast-util-to-estree`) consume it the same way.
 */
export function rehypeShiki(options: ShikiOptions = {}): Plugin<[], Root> {
	const theme = options.theme ?? DEFAULT_THEME;
	const transformers = options.transformers ?? [];
	return () => async (tree) => {
		const targets = collectCodeBlocks(tree);
		if (targets.length === 0) return;

		const highlighter = await getHighlighter();
		const knownLangs = new Set<string>(highlighter.getLoadedLanguages().concat(["plaintext"]));

		for (const t of targets) {
			const lang = knownLangs.has(t.lang) ? t.lang : "plaintext";
			let html: string;
			try {
				html = highlighter.codeToHtml(t.code, { lang, theme, transformers });
			} catch {
				html = highlighter.codeToHtml(t.code, {
					lang: "plaintext",
					theme,
					transformers,
				});
			}
			// Replace the original `<pre>` with a raw node carrying Shiki's
			// HTML. Both downstream stringifiers (rehype-stringify with
			// allowDangerousHtml, MDX's hast-util-to-estree) handle raw
			// nodes as expected.
			t.parent.children[t.index] = { type: "raw", value: html } as never;
		}
	};
}

interface CodeBlockTarget {
	parent: Root | Element;
	index: number;
	lang: string;
	code: string;
}

function collectCodeBlocks(tree: Root): CodeBlockTarget[] {
	const targets: CodeBlockTarget[] = [];
	const visit = (parent: Root | Element): void => {
		if (!Array.isArray(parent.children)) return;
		for (let i = 0; i < parent.children.length; i++) {
			const child = parent.children[i];
			if (
				child &&
				typeof child === "object" &&
				(child as Element).type === "element" &&
				(child as Element).tagName === "pre"
			) {
				const pre = child as Element;
				const codeEl = (pre.children?.[0] as Element | undefined) ?? null;
				if (
					codeEl &&
					codeEl.type === "element" &&
					codeEl.tagName === "code" &&
					Array.isArray(codeEl.children)
				) {
					targets.push({
						parent,
						index: i,
						lang: extractLang(codeEl),
						code: extractText(codeEl),
					});
					continue;
				}
			}
			if (child && (child as Element).type === "element") {
				visit(child as Element);
			}
		}
	};
	visit(tree);
	return targets;
}

function extractLang(codeEl: Element): string {
	const className = codeEl.properties?.className;
	if (Array.isArray(className)) {
		for (const c of className) {
			if (typeof c === "string" && c.startsWith("language-")) {
				return c.slice("language-".length);
			}
		}
	}
	return "plaintext";
}

function extractText(codeEl: Element): string {
	let out = "";
	for (const c of codeEl.children) {
		if (c.type === "text") {
			out += c.value;
		}
	}
	return out;
}
