/**
 * `.mdx` compiler.
 *
 * Compiles MDX (JSX-in-Markdown) into the same Astroflare component ABI
 * shape `.astro` and `.md` produce — a default-exported `$component`.
 *
 * Pipeline:
 *
 *   1. Strip YAML frontmatter from the source so MDX's parser doesn't see
 *      `---` as a thematic break. Frontmatter shows up two ways in the
 *      emitted module:
 *        - `Astro.props.frontmatter` at render time
 *        - `export const frontmatter = …` for cross-module
 *          `import { frontmatter } from "./post.mdx"` (Phase 14's named-
 *          export hoist).
 *   2. Run `@mdx-js/mdx`'s `compile()` with
 *      `jsxImportSource: "@astroflare/runtime"`. The output is a program
 *      that imports `_jsx` / `_jsxs` / `_Fragment` from
 *      `@astroflare/runtime/jsx-runtime` and `export default`s an
 *      `MDXContent(props)` function.
 *   3. Rewrite the jsx-runtime import. The inline bundler strips every
 *      top-level import inside an IIFE; `_jsx` / `_jsxs` / `_Fragment`
 *      need to bind to *something*. We replace the whole import line
 *      with `const _jsx = jsx, _jsxs = jsxs, _Fragment = Fragment;`
 *      where `jsx` / `jsxs` / `Fragment` come from the bundle's outer
 *      scope (`BUNDLE_RUNTIME_SYMBOLS` was extended in Phase 14).
 *   4. Rename the default export. MDX writes `export default function
 *      MDXContent(props) {…}`; we strip the `export default` so it
 *      becomes a plain declaration, then append our own
 *      `export default $component(async ({Astro, …$$props}, $$slots) =>
 *      $rawHtml(await MDXContent($$props)))` so the rest of the
 *      framework consumes MDX modules through the standard
 *      `AstroComponent` ABI.
 *
 * Phase 14 carve-outs (deferred until real demand surfaces):
 *   - User remark/rehype plugin chains. The compiler accepts the same
 *     `remarkPlugins` / `rehypePlugins` shape for internal use (Shiki
 *     rides in this way) but doesn't yet thread them through from
 *     `astro.config.ts`.
 *   - MDX layout/wrapper components-from-config (Astro's
 *     `MDXProvider`-style API).
 *   - JSX in `.astro` frontmatter (different surface; would need its
 *     own compile path).
 */

import { compile as mdxCompile } from "@mdx-js/mdx";
import rehypeRaw from "rehype-raw";
import type { PluggableList, Plugin } from "unified";
import { parse as parseYaml } from "yaml";
import { rehypeShiki } from "../shiki/index.js";

const RUNTIME_SYMBOLS = ["$component", "$render", "$rawHtml"] as const;

const DEFAULT_RUNTIME_IMPORT = "@astroflare/runtime/internal";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const JSX_RUNTIME_IMPORT_RE =
	/^[ \t]*import[ \t]*\{([^}]*)\}[ \t]+from[ \t]+["']@astroflare\/runtime\/jsx-runtime["'];?[ \t]*\r?\n?/m;

/**
 * Match `export default function <name>(<args>) {`. Captures the function
 * name (group 1) so we can append a custom-wrapped default at the bottom.
 *
 * MDX 3 emits this exact shape — we don't need to handle the
 * `function …; export default …;` form because MDX never produces it.
 */
const EXPORT_DEFAULT_FUNC_RE = /^[ \t]*export[ \t]+default[ \t]+function[ \t]+/m;

export interface MdxCompileOptions {
	/** Module specifier for the runtime ABI (default `@astroflare/runtime/internal`). */
	runtimeImport?: string;
	/** Source filename for error messages. */
	filename?: string;
	/**
	 * Enable Shiki syntax highlighting on fenced code blocks. See
	 * `MarkdownCompileOptions.shiki` for the rationale — only the
	 * pure-JS regex engine ships, since Astroflare's hard rule is
	 * "Workers-runnable only" and the WASM engine isn't.
	 */
	shiki?: boolean;
	/** Extra remark plugins. Internal — reserved for future config plumbing. */
	remarkPlugins?: Plugin[];
	/** Extra rehype plugins. Internal — reserved for future config plumbing. */
	rehypePlugins?: Plugin[];
}

export interface MdxCompileResult {
	code: string;
	frontmatter: Record<string, unknown>;
}

export async function compileMdx(
	source: string,
	opts: MdxCompileOptions = {},
): Promise<MdxCompileResult> {
	const runtimeImport = opts.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;

	// 1. Pull out YAML frontmatter before MDX sees it. MDX would otherwise
	//    parse `---` as a thematic break and the YAML as literal paragraphs.
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
				`mdx: invalid YAML frontmatter${
					opts.filename ? ` in ${opts.filename}` : ""
				}: ${(err as Error).message}`,
			);
		}
		body = source.slice(fmMatch[0].length);
	}

	// 2. Compile MDX. `jsxImportSource` controls where the JSX runtime is
	//    imported from; we route it to `@astroflare/runtime/jsx-runtime`
	//    so post-processing can find and rewrite the import line in step 3.
	//
	//    Shiki rides as the default rehype plugin (Phase 14). It emits
	//    `raw`-typed hast nodes — `hast-util-to-estree` (used by MDX) can't
	//    consume those directly, so `rehype-raw` follows immediately to
	//    re-parse them back into proper element subtrees. (For `.md` the
	//    same `raw` nodes flow through `rehype-stringify` with
	//    `allowDangerousHtml`, no rehype-raw needed.)
	// rehype-raw is required after Shiki so its `raw` output nodes get
	// re-parsed into proper hast subtrees — `hast-util-to-estree` (used
	// by MDX) can't consume `raw` nodes directly. `passThrough` keeps
	// MDX-native AST nodes (JSX elements, `{expr}` expressions,
	// `import`/`export` blocks) intact; without it rehype-raw tries to
	// HTML-parse them and crashes on the first `mdxJsxFlowElement`.
	const MDX_NODE_TYPES = [
		"mdxFlowExpression",
		"mdxJsxFlowElement",
		"mdxJsxTextElement",
		"mdxTextExpression",
		"mdxjsEsm",
	];
	const rehypePlugins: PluggableList = [];
	if (opts.shiki) {
		rehypePlugins.push(rehypeShiki());
		rehypePlugins.push([rehypeRaw, { passThrough: MDX_NODE_TYPES }]);
	}
	for (const p of opts.rehypePlugins ?? []) {
		rehypePlugins.push(p);
	}
	let mdxCompiled: string;
	try {
		const vfile = await mdxCompile(body, {
			jsxImportSource: "@astroflare/runtime",
			development: false,
			remarkPlugins: opts.remarkPlugins ?? [],
			rehypePlugins,
		});
		mdxCompiled = String(vfile);
	} catch (err) {
		throw new Error(
			`mdx: compile failed${opts.filename ? ` in ${opts.filename}` : ""}: ${
				(err as Error).message
			}`,
		);
	}

	// 3. Rewrite the jsx-runtime import. The inline bundler will strip any
	//    top-level `import` inside an IIFE, so we convert it into a const
	//    aliasing the bundle-outer-scope `jsx` / `jsxs` / `Fragment`.
	const importMatch = JSX_RUNTIME_IMPORT_RE.exec(mdxCompiled);
	if (importMatch) {
		const aliases = parseImportSpecList(importMatch[1] as string);
		const aliasDecl =
			aliases.length > 0
				? `const ${aliases.map((a) => `${a.local} = ${a.imported}`).join(", ")};\n`
				: "";
		mdxCompiled = mdxCompiled.replace(JSX_RUNTIME_IMPORT_RE, aliasDecl);
	}

	// 4. Strip `export default` from MDX's `MDXContent` declaration so it
	//    becomes a plain `function MDXContent(...)` we can call from our
	//    wrapper. Then append the wrapper.
	const exportMatch = EXPORT_DEFAULT_FUNC_RE.exec(mdxCompiled);
	if (!exportMatch) {
		throw new Error(
			`mdx: unexpected compile output (no \`export default function …\`)${
				opts.filename ? ` in ${opts.filename}` : ""
			}`,
		);
	}
	mdxCompiled = mdxCompiled.replace(EXPORT_DEFAULT_FUNC_RE, "function ");

	// 5. Emit the final module. The runtime import is *outside* the IIFE
	//    (the inline bundler hoists it to the bundle's outer scope); the
	//    MDX-compiled body sits below, then the frontmatter export, then
	//    the wrapped default. Order matters: the wrapper closes over
	//    `frontmatter` and `MDXContent` defined above.
	const code = [
		`import { ${RUNTIME_SYMBOLS.join(", ")} } from ${JSON.stringify(runtimeImport)};`,
		"",
		mdxCompiled.trimEnd(),
		"",
		`export const frontmatter = ${JSON.stringify(frontmatter)};`,
		"",
		"export default $component(async ({ Astro, ...$$props }, $$slots) => {",
		"  Astro.props.frontmatter = frontmatter;",
		"  void $$slots;",
		"  return $render`${$rawHtml(await MDXContent($$props))}`;",
		"});",
		"",
	].join("\n");

	return { code, frontmatter };
}

interface ImportSpec {
	imported: string;
	local: string;
}

function parseImportSpecList(inner: string): ImportSpec[] {
	const out: ImportSpec[] = [];
	for (const part of inner.split(",")) {
		const p = part.trim();
		if (!p) continue;
		const asMatch = /^([A-Za-z_$][\w$]*)[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(p);
		if (asMatch) {
			out.push({ imported: asMatch[1] as string, local: asMatch[2] as string });
		} else if (/^[A-Za-z_$][\w$]*$/.test(p)) {
			out.push({ imported: p, local: p });
		}
	}
	return out;
}
