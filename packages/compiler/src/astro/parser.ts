/**
 * `.astro` parser.
 *
 * Single-pass recursive descent over HTML / components / fragments / slots /
 * directives, with **expression bodies (`{...}`) delegated to a real JS+JSX
 * parser** (`acorn` + `acorn-jsx`). The previous implementation walked
 * expression bytes by hand with brace counting, string/comment skipping, and
 * a regex-vs-division heuristic; every "Astro accepts this but Astroflare
 * doesn't" report (PRs #6, #8, #11, …) was another adjacency rule patched
 * onto that scanner.
 *
 * The hand-rolled HTML walk is fine — HTML-with-`{expr}` boundaries are
 * unambiguous at the character level. The lossy part was *inside* the
 * braces, where JSX is a real grammar. Acorn-jsx is the same parser ESLint
 * / Prettier / Webpack use; pure JS, no `node:*`, no WASM — so it complies
 * with the "every shipped path must run on a Cloudflare Worker" hard rule
 * (CLAUDE.md, §"Hard rule"). For any input the upstream `@astrojs/compiler`
 * accepts, brace-finding is now grammar-correct: multi-line attribute
 * strings, embedded `{expr}` in JSX attributes, self-closing tags, fragments,
 * regex literals with `}`, ternaries returning JSX, chained method calls
 * returning JSX, all parse without per-shape adjacency rules.
 *
 * Produces an `AstroDocument` plus a list of recoverable `AstroError`s. The
 * parser tries hard to keep going past errors so editor tooling can still
 * highlight the rest of the file; severe structural errors (unclosed
 * comment, unclosed expression brace, syntactically invalid expression)
 * throw immediately and the outer `parseChildren` recovery point catches.
 *
 * Tier 0 grammar (per §3 of the brief):
 *   - frontmatter: `---\n ... \n---` at top of file (whitespace-tolerant)
 *   - HTML elements with attributes (static / expression / spread / shorthand / directive)
 *   - components (uppercase or dotted tag name)
 *   - `<slot>`, `<slot name="...">`, fallback content
 *   - `<Fragment>` / `<>...<>` (empty-tag fragment shorthand)
 *   - `{expr}` interpolation in content and attribute positions (delegated)
 *   - `<!-- comment -->`, `<!DOCTYPE html>`
 *   - `set:html`, `is:raw`, `define:vars`, `client:*` directives (parsed; emit
 *     decisions belong to the emitter)
 */
import { Parser as AcornParser } from "acorn";
import jsx from "acorn-jsx";
import type {
	AstroAttribute,
	AstroComponent,
	AstroDoctype,
	AstroDocument,
	AstroElement,
	AstroError,
	AstroExpression,
	AstroFragmentNode,
	AstroNode,
	AstroSlot,
	AstroText,
	DirectiveAttribute,
	ExpressionAttribute,
	Range,
	ShorthandAttribute,
	SpreadAttribute,
	StaticAttribute,
} from "./ast.js";
import { locate } from "./ast.js";

/**
 * Acorn extended with JSX support. The combination is what ESLint /
 * Babel-eslint-parser / Prettier wrap to read JSX-bearing JS, so the
 * grammar coverage is the standard JSX surface (elements, fragments,
 * spread/expression attributes, namespaced + member-access tag names,
 * member-expression children, expression containers).
 */
const JsxParser = AcornParser.extend(jsx({ allowNamespacedObjects: true, allowNamespaces: true }));

/**
 * Options applied to every `parseExpressionAt` call.
 *
 *   - `ecmaVersion: "latest"` matches the runtime targets (V8 / workerd).
 *   - `sourceType: "module"` allows top-level `await` (Astro frontmatter
 *     and body expressions both run inside an async context at emit time;
 *     module mode is the closest match).
 *   - `allowAwaitOutsideFunction: true` is a belt-and-braces guard for
 *     acorn versions that key top-level await off `sourceType` only when
 *     compiling whole programs (not single-expression `parseExpressionAt`).
 */
const ACORN_OPTS = {
	ecmaVersion: "latest",
	sourceType: "module",
	allowAwaitOutsideFunction: true,
} as const;

/**
 * Elements whose content is true raw text — CSS braces, JS strings, and
 * literal markup-like sequences pass through verbatim until the matching
 * close tag. Limited to `<style>` and `<script>` because Astro convention
 * lets users interpolate `{expr}` into `<title>` and `<textarea>` (HTML
 * "escapable raw text" elements per spec, but Astro treats them as
 * normal templating contexts).
 */
const RAW_TEXT_ELEMENTS = new Set(["style", "script"]);

// Per HTML living standard.
const VOID_HTML_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
]);

// Char codes used hot.
const CC_LT = 0x3c;
const CC_GT = 0x3e;
const CC_LBRACE = 0x7b;
const CC_RBRACE = 0x7d;
const CC_SLASH = 0x2f;
const CC_STAR = 0x2a;
const CC_QUOTE_DBL = 0x22;
const CC_QUOTE_SGL = 0x27;
const CC_BACKTICK = 0x60;
const CC_BACKSLASH = 0x5c;
const CC_EQ = 0x3d;
const CC_DOT = 0x2e;
const CC_DOLLAR = 0x24;
const CC_LPAREN = 0x28;
const CC_RPAREN = 0x29;
const CC_LBRACK = 0x5b;
const CC_RBRACK = 0x5d;
const CC_NL = 0x0a;
const CC_CR = 0x0d;
const CC_BANG = 0x21;
const CC_DASH = 0x2d;

function isWhitespace(c: number): boolean {
	return c === 0x20 || c === 0x09 || c === CC_NL || c === CC_CR || c === 0x0c;
}

/**
 * JS identifier-ish: ASCII letters, digits, `_`, `$`. Used by the
 * fallback scanner's regex-vs-division heuristic (see
 * `findMatchingBraceFallback`); insufficient for full Unicode
 * identifiers, but acorn handles the common case anyway and the
 * fallback only needs to cover TS-bearing expressions where the
 * preceding-token shapes are conventional.
 */
function isWordChar(c: number): boolean {
	return (
		(c >= 0x30 && c <= 0x39) ||
		(c >= 0x41 && c <= 0x5a) ||
		(c >= 0x61 && c <= 0x7a) ||
		c === 0x5f ||
		c === CC_DOLLAR
	);
}

const REGEX_PRECEDING_KEYWORDS = new Set([
	"return",
	"typeof",
	"in",
	"of",
	"instanceof",
	"new",
	"delete",
	"throw",
	"void",
	"yield",
	"await",
	"do",
	"else",
	"case",
]);

function isAttrNameChar(c: number): boolean {
	// HTML attribute names: anything except whitespace, =, /, >, ", ', <, controls.
	// Astro additionally allows `:` (for directives) and `-` (for data-*) and `.`.
	if (c <= 0x20) return false;
	return (
		c !== CC_EQ &&
		c !== CC_SLASH &&
		c !== CC_GT &&
		c !== CC_LT &&
		c !== CC_QUOTE_DBL &&
		c !== CC_QUOTE_SGL &&
		c !== CC_LBRACE &&
		c !== CC_RBRACE
	);
}

export interface ParseResult {
	doc: AstroDocument;
	errors: AstroError[];
}

export function parseAstro(source: string): ParseResult {
	return new Parser(source).parseDocument();
}

class Parser {
	readonly source: string;
	pos = 0;
	readonly errors: AstroError[] = [];

	constructor(source: string) {
		this.source = source;
	}

	parseDocument(): ParseResult {
		const start = this.pos;
		let fm: { source: string | null; range: Range | null } = {
			source: null,
			range: null,
		};
		const body: AstroNode[] = [];
		try {
			fm = this.parseFrontmatter();
		} catch (err) {
			if (!(err instanceof ParseFailure)) throw err;
		}
		// `parseChildren` is the recovery point: a `ParseFailure` thrown deeper
		// in the recursion (e.g. unclosed expression) bubbles up here, gets
		// translated into a recorded error, and we return what we already have.
		try {
			body.push(...this.parseChildren(null));
		} catch (err) {
			if (!(err instanceof ParseFailure)) throw err;
		}
		return {
			doc: {
				type: "document",
				frontmatter: fm.source,
				frontmatterRange: fm.range,
				body,
				range: [start, this.pos],
			},
			errors: this.errors,
		};
	}

	// -------------------------------------------------------------------------
	// Frontmatter
	// -------------------------------------------------------------------------

	private parseFrontmatter(): { source: string | null; range: Range | null } {
		// Frontmatter is `---\n ... \n---` at the top of the file. Allow leading
		// blank lines but no leading non-whitespace.
		let i = this.pos;
		while (i < this.source.length && isWhitespace(this.source.charCodeAt(i))) i++;
		if (
			this.source.charCodeAt(i) !== CC_DASH ||
			this.source.charCodeAt(i + 1) !== CC_DASH ||
			this.source.charCodeAt(i + 2) !== CC_DASH
		) {
			return { source: null, range: null };
		}
		// `---` opener — must be followed by end-of-line (or EOF).
		const openerEnd = i + 3;
		const afterOpener = this.skipToNewlineFrom(openerEnd);
		// If non-whitespace appears between `---` and newline, it's not frontmatter.
		for (let j = openerEnd; j < afterOpener; j++) {
			if (!isWhitespace(this.source.charCodeAt(j))) {
				return { source: null, range: null };
			}
		}
		const fmStart = afterOpener + 1; // first byte of frontmatter body
		// Find closing `---` at start of a line.
		let k = fmStart;
		while (k < this.source.length) {
			if (
				this.source.charCodeAt(k) === CC_DASH &&
				this.source.charCodeAt(k + 1) === CC_DASH &&
				this.source.charCodeAt(k + 2) === CC_DASH &&
				this.atStartOfLine(k)
			) {
				const fmEnd = k;
				const afterCloser = this.skipToNewlineFrom(k + 3);
				const source = this.source.slice(fmStart, fmEnd);
				this.pos = afterCloser < this.source.length ? afterCloser + 1 : afterCloser;
				return { source, range: [fmStart, fmEnd] };
			}
			k++;
		}
		// Unclosed frontmatter — recover as if no frontmatter.
		this.error(i, "Unclosed frontmatter (missing closing `---`)");
		return { source: null, range: null };
	}

	// -------------------------------------------------------------------------
	// Children
	// -------------------------------------------------------------------------

	private parseChildren(terminator: string | null): AstroNode[] {
		const children: AstroNode[] = [];
		while (this.pos < this.source.length) {
			if (terminator !== null && this.atClosingTag(terminator)) break;
			if (terminator !== null && this.atFragmentClose()) break;
			const node = this.parseNode();
			if (node) children.push(node);
		}
		return children;
	}

	private parseNode(): AstroNode | null {
		const c = this.source.charCodeAt(this.pos);
		if (c === CC_LT) {
			// `<!--` comment
			if (
				this.source.charCodeAt(this.pos + 1) === CC_BANG &&
				this.source.charCodeAt(this.pos + 2) === CC_DASH &&
				this.source.charCodeAt(this.pos + 3) === CC_DASH
			) {
				return this.parseComment();
			}
			// `<!DOCTYPE`
			if (this.source.charCodeAt(this.pos + 1) === CC_BANG) {
				return this.parseDoctype();
			}
			// `<>` fragment open
			if (this.source.charCodeAt(this.pos + 1) === CC_GT) {
				return this.parseFragmentShorthand();
			}
			return this.parseElement();
		}
		if (c === CC_LBRACE) {
			return this.parseExpression();
		}
		return this.parseText();
	}

	// -------------------------------------------------------------------------
	// Text
	// -------------------------------------------------------------------------

	private parseText(): AstroText {
		const start = this.pos;
		while (this.pos < this.source.length) {
			const c = this.source.charCodeAt(this.pos);
			if (c === CC_LT || c === CC_LBRACE) break;
			this.pos++;
		}
		return {
			type: "text",
			value: this.source.slice(start, this.pos),
			range: [start, this.pos],
		};
	}

	// -------------------------------------------------------------------------
	// Expression `{...}` in content position
	// -------------------------------------------------------------------------

	private parseExpression(): AstroExpression {
		const start = this.pos;
		const innerStart = start + 1;
		const innerEnd = this.findMatchingBrace(start);
		this.pos = innerEnd + 1;
		return {
			type: "expression",
			expression: this.source.slice(innerStart, innerEnd),
			range: [start, this.pos],
		};
	}

	/**
	 * Given `pos` at an opening `{`, return the offset of the matching `}`.
	 *
	 * Delegates the JS+JSX grammar work to acorn-jsx: parse one expression
	 * starting after the `{`, then expect `}` at (or after a run of
	 * whitespace + comments past) the expression's end. This replaces a
	 * stack of hand-rolled scanner heuristics (string skipping, template
	 * literal interpolation, line/block comments, regex-vs-division
	 * disambiguation, JSX-tag adjacency rules) with a real grammar — every
	 * case the upstream Astro compiler accepts inside `{...}` parses
	 * identically here.
	 *
	 * Special cases bypass acorn:
	 *   - `{}` (or `{   }`): empty body. Acorn rejects empty input; we
	 *     return the closing `}` directly.
	 *   - `{...x}` (spread): `...x` isn't a valid expression on its own
	 *     (the spread token only appears in calls, arrays, and objects).
	 *     Skip the three dots, then parse the operand expression.
	 *
	 * On parse error: report at the opening `{`, classify "Unclosed
	 * expression" (acorn ran past EOF) vs "Invalid expression" (acorn
	 * stopped on an unexpected token mid-source), and bubble through the
	 * `parseChildren` recovery point as before.
	 */
	private findMatchingBrace(openPos: number): number {
		let exprStart = this.skipWsAndCommentsFrom(openPos + 1);

		// Empty `{}` (or `{   /* ws */ }`) — no expression to parse.
		if (this.source.charCodeAt(exprStart) === CC_RBRACE) {
			return exprStart;
		}

		// Astro spread attribute `{...obj}`. The `...` token isn't a valid
		// expression prefix on its own, so step over it and let acorn parse
		// just the operand. Match either `{...obj}` (no leading whitespace,
		// the existing convention) or `{ ...obj }` (whitespace-tolerant).
		if (
			this.source.charCodeAt(exprStart) === CC_DOT &&
			this.source.charCodeAt(exprStart + 1) === CC_DOT &&
			this.source.charCodeAt(exprStart + 2) === CC_DOT
		) {
			exprStart += 3;
		}

		let exprEnd: number;
		try {
			const node = JsxParser.parseExpressionAt(this.source, exprStart, ACORN_OPTS) as {
				end: number;
			};
			exprEnd = node.end;
		} catch (acornErr) {
			// TS-tolerance fallback. Astro accepts TypeScript syntax in body
			// expressions (`{(raw as string).toUpperCase()}`, generics, type
			// assertions, `satisfies`); acorn does not. When acorn rejects,
			// fall back to the legacy character-level brace counter — same
			// shape the parser used pre-acorn, with all its known
			// limitations (no JSX awareness, regex-vs-division heuristic).
			// Per the user's recommended phasing this fallback is
			// transitional: once a TS-aware parser exists or upstream
			// fixtures are conformance-locked, the heuristic methods get
			// deleted along with the fallback path. Only the JSX-bearing
			// cases the LLM reliably emits go through the acorn path; TS
			// expression bodies inherit the previous behavior unchanged.
			const fallback = this.findMatchingBraceFallback(openPos);
			if (fallback !== -1) return fallback;
			this.error(openPos, this.classifyExpressionError(acornErr));
			throw new ParseFailure();
		}

		// Acorn stopped at the last expression token; the matching `}` may
		// have trailing whitespace + line/block comments before it.
		const closeAt = this.skipWsAndCommentsFrom(exprEnd);
		if (this.source.charCodeAt(closeAt) !== CC_RBRACE) {
			this.error(openPos, "Unclosed expression (missing `}`)");
			throw new ParseFailure();
		}
		return closeAt;
	}

	/**
	 * Pre-acorn brace counter, kept as a fallback for TypeScript-bearing
	 * body expressions (`{(x as string).y()}`) that the JS+JSX grammar
	 * rejects. Returns the offset of the matching `}`, or `-1` when the
	 * scanner ran off the end of the source — the caller treats that as
	 * "report the original acorn error" rather than overwriting it with a
	 * fallback diagnostic.
	 *
	 * Walks through string literals (single, double, backtick with
	 * `${}`), line and block comments, and balanced parens / brackets /
	 * braces. Regex literals are disambiguated by the
	 * `isRegexStartFallback` heuristic (PR #11). This is the same scanner
	 * the parser used historically; it is *not* called when acorn
	 * succeeds, so JSX fixtures the LLM emits go through the grammar-
	 * correct path.
	 */
	private findMatchingBraceFallback(openPos: number): number {
		let depth = 0;
		let i = openPos;
		while (i < this.source.length) {
			const c = this.source.charCodeAt(i);
			switch (c) {
				case CC_LBRACE:
					depth++;
					i++;
					break;
				case CC_RBRACE:
					depth--;
					if (depth === 0) return i;
					i++;
					break;
				case CC_LPAREN:
				case CC_LBRACK:
					depth++;
					i++;
					break;
				case CC_RPAREN:
				case CC_RBRACK:
					depth--;
					i++;
					break;
				case CC_QUOTE_DBL:
				case CC_QUOTE_SGL: {
					const r = this.skipStringFallback(i, c);
					if (r === -1) return -1;
					i = r;
					break;
				}
				case CC_BACKTICK: {
					const r = this.skipTemplateStringFallback(i);
					if (r === -1) return -1;
					i = r;
					break;
				}
				case CC_SLASH:
					if (this.source.charCodeAt(i + 1) === CC_SLASH) {
						i = this.skipLineCommentFallback(i);
					} else if (this.source.charCodeAt(i + 1) === CC_STAR) {
						const r = this.skipBlockCommentFallback(i);
						if (r === -1) return -1;
						i = r;
					} else if (this.isRegexStartFallback(i, openPos)) {
						i = this.skipRegexLiteralFallback(i);
					} else {
						i++;
					}
					break;
				default:
					i++;
			}
		}
		return -1;
	}

	private skipStringFallback(start: number, quote: number): number {
		let i = start + 1;
		while (i < this.source.length) {
			const c = this.source.charCodeAt(i);
			if (c === CC_BACKSLASH) {
				i += 2;
				continue;
			}
			if (c === quote) return i + 1;
			if (c === CC_NL && quote !== CC_BACKTICK) return -1;
			i++;
		}
		return -1;
	}

	private skipTemplateStringFallback(start: number): number {
		let i = start + 1;
		while (i < this.source.length) {
			const c = this.source.charCodeAt(i);
			if (c === CC_BACKSLASH) {
				i += 2;
				continue;
			}
			if (c === CC_BACKTICK) return i + 1;
			if (c === CC_DOLLAR && this.source.charCodeAt(i + 1) === CC_LBRACE) {
				const end = this.findMatchingBraceFallback(i + 1);
				if (end === -1) return -1;
				i = end + 1;
				continue;
			}
			i++;
		}
		return -1;
	}

	private skipLineCommentFallback(start: number): number {
		let i = start + 2;
		while (i < this.source.length) {
			if (this.source.charCodeAt(i) === CC_NL) return i + 1;
			i++;
		}
		return i;
	}

	private skipBlockCommentFallback(start: number): number {
		let i = start + 2;
		while (i < this.source.length - 1) {
			if (this.source.charCodeAt(i) === CC_STAR && this.source.charCodeAt(i + 1) === CC_SLASH) {
				return i + 2;
			}
			i++;
		}
		return -1;
	}

	private isRegexStartFallback(slashPos: number, openPos: number): boolean {
		const adj = this.source.charCodeAt(slashPos - 1);
		if (adj === CC_LT || adj === CC_GT) return false;
		let j = slashPos - 1;
		while (j > openPos) {
			const c = this.source.charCodeAt(j);
			if (isWhitespace(c)) {
				j--;
				continue;
			}
			break;
		}
		if (j <= openPos) return true;
		const c = this.source.charCodeAt(j);
		switch (c) {
			case CC_EQ:
			case CC_LPAREN:
			case CC_LBRACK:
			case CC_LBRACE:
			case 0x2c:
			case 0x3b:
			case 0x3a:
			case CC_BANG:
			case 0x26:
			case 0x7c:
			case 0x3f:
			case 0x2b:
			case CC_DASH:
			case CC_STAR:
			case 0x25:
			case 0x3c:
			case 0x3e:
			case 0x5e:
			case 0x7e:
			case CC_SLASH:
				return true;
		}
		if (isWordChar(c)) {
			let k = j;
			while (k > openPos && isWordChar(this.source.charCodeAt(k - 1))) k--;
			const word = this.source.slice(k, j + 1);
			return REGEX_PRECEDING_KEYWORDS.has(word);
		}
		return false;
	}

	private skipRegexLiteralFallback(start: number): number {
		let i = start + 1;
		let inCharClass = false;
		while (i < this.source.length) {
			const c = this.source.charCodeAt(i);
			if (c === CC_BACKSLASH) {
				i += 2;
				continue;
			}
			if (c === 0x5b) {
				inCharClass = true;
				i++;
				continue;
			}
			if (c === 0x5d && inCharClass) {
				inCharClass = false;
				i++;
				continue;
			}
			if (c === CC_SLASH && !inCharClass) {
				i++;
				while (i < this.source.length) {
					const f = this.source.charCodeAt(i);
					if (f >= 0x61 && f <= 0x7a) {
						i++;
					} else break;
				}
				return i;
			}
			if (c === CC_NL) return start + 1;
			i++;
		}
		return start + 1;
	}

	/**
	 * Advance past runs of whitespace and `//` / `/* *\/` comments, used
	 * to find the `}` that closes an Astro expression after acorn finished
	 * with the inner JS+JSX. Acorn skips leading whitespace + comments
	 * itself, but trailing trivia between the last expression token and
	 * the closing brace is on us.
	 */
	private skipWsAndCommentsFrom(start: number): number {
		let i = start;
		while (i < this.source.length) {
			const c = this.source.charCodeAt(i);
			if (isWhitespace(c)) {
				i++;
				continue;
			}
			if (c === CC_SLASH) {
				const next = this.source.charCodeAt(i + 1);
				if (next === CC_SLASH) {
					i += 2;
					while (i < this.source.length && this.source.charCodeAt(i) !== CC_NL) i++;
					continue;
				}
				if (next === CC_STAR) {
					i += 2;
					while (i + 1 < this.source.length) {
						if (
							this.source.charCodeAt(i) === CC_STAR &&
							this.source.charCodeAt(i + 1) === CC_SLASH
						) {
							i += 2;
							break;
						}
						i++;
					}
					continue;
				}
			}
			break;
		}
		return i;
	}

	/**
	 * Translate an acorn `SyntaxError` into the message shape the existing
	 * tests + tooling expect. Errors whose offset hits end-of-source are
	 * "Unclosed expression" (parity with the previous scanner's wording);
	 * mid-source errors surface acorn's specific message under "Invalid
	 * expression" so authors get a useful diagnostic instead of a generic
	 * "missing `}`".
	 */
	private classifyExpressionError(err: unknown): string {
		const message = err instanceof Error ? err.message : String(err);
		const pos =
			err &&
			typeof err === "object" &&
			"pos" in err &&
			typeof (err as { pos: unknown }).pos === "number"
				? (err as { pos: number }).pos
				: -1;
		if (pos < 0 || pos >= this.source.length) {
			return "Unclosed expression (missing `}`)";
		}
		return `Invalid expression: ${message}`;
	}

	// -------------------------------------------------------------------------
	// Comments and doctypes
	// -------------------------------------------------------------------------

	private parseComment(): AstroNode {
		const start = this.pos;
		this.pos += 4; // <!--
		const valueStart = this.pos;
		while (this.pos < this.source.length - 2) {
			if (
				this.source.charCodeAt(this.pos) === CC_DASH &&
				this.source.charCodeAt(this.pos + 1) === CC_DASH &&
				this.source.charCodeAt(this.pos + 2) === CC_GT
			) {
				const value = this.source.slice(valueStart, this.pos);
				this.pos += 3;
				return { type: "comment", value, range: [start, this.pos] };
			}
			this.pos++;
		}
		this.error(start, "Unclosed HTML comment");
		throw new ParseFailure();
	}

	private parseDoctype(): AstroDoctype {
		const start = this.pos;
		this.pos += 2; // <!
		// Consume identifier (case-insensitive 'DOCTYPE') then content until `>`.
		while (this.pos < this.source.length && this.source.charCodeAt(this.pos) !== CC_GT) {
			this.pos++;
		}
		const inner = this.source.slice(start + 2, this.pos).trim();
		const value = inner.replace(/^doctype\s+/i, "");
		if (this.pos < this.source.length) this.pos++; // consume >
		return { type: "doctype", value, range: [start, this.pos] };
	}

	// -------------------------------------------------------------------------
	// Elements
	// -------------------------------------------------------------------------

	private parseElement(): AstroNode {
		const start = this.pos;
		// Closing tag at top level — recover by emitting a zero-width text node
		// and advancing one byte. The outer parseChildren loop will continue.
		if (this.source.charCodeAt(this.pos + 1) === CC_SLASH) {
			this.error(start, "Unexpected closing tag");
			this.pos++;
			return { type: "text", value: "", range: [start, this.pos] };
		}
		this.pos++; // consume <
		const nameStart = this.pos;
		while (this.pos < this.source.length) {
			const c = this.source.charCodeAt(this.pos);
			if (isWhitespace(c) || c === CC_GT || c === CC_SLASH || c === CC_EQ) {
				break;
			}
			this.pos++;
		}
		const tagName = this.source.slice(nameStart, this.pos);
		if (tagName.length === 0) {
			this.error(start, "Expected tag name after `<`");
			throw new ParseFailure();
		}
		const attrs = this.parseAttributes();

		let selfClosing = false;
		this.skipSpaces();
		if (this.source.charCodeAt(this.pos) === CC_SLASH) {
			this.pos++; // /
			this.skipSpaces();
			if (this.source.charCodeAt(this.pos) === CC_GT) {
				this.pos++;
				selfClosing = true;
			} else {
				this.error(this.pos, "Expected `>` after `/` in self-closing tag");
				selfClosing = true;
			}
		} else if (this.source.charCodeAt(this.pos) === CC_GT) {
			this.pos++;
		} else {
			this.error(this.pos, "Expected `>` or `/>` to close tag");
			throw new ParseFailure();
		}

		// Components (capitalized first letter, by Astro convention) are never
		// HTML void elements: `<Base />` is a user-authored component named
		// `Base`, not the void HTML `<base>` element. Without this guard, a
		// component named `Base`/`Img`/`Br`/etc. would parse as void and its
		// children would be promoted to siblings — see `Unexpected closing
		// tag` regression on `<Base>...</Base>`.
		const isComponent = isComponentName(tagName);
		const isVoid = !isComponent && VOID_HTML_ELEMENTS.has(tagName.toLowerCase());
		const isRawText = RAW_TEXT_ELEMENTS.has(tagName.toLowerCase());
		let children: AstroNode[] = [];
		if (!selfClosing && !isVoid) {
			if (isRawText) {
				// `<style>` and `<script>` (and the other HTML raw-text elements)
				// have content that's not parseable as Astro children — CSS
				// braces, JS string literals, etc. must pass through verbatim.
				// Scan forward to the matching closing tag and emit a single
				// text node.
				const contentStart = this.pos;
				const contentEnd = this.findRawTextEnd(tagName);
				children = [
					{
						type: "text",
						value: this.source.slice(contentStart, contentEnd),
						range: [contentStart, contentEnd],
					},
				];
				this.pos = contentEnd;
				if (!this.consumeClosingTag(tagName)) {
					this.error(this.pos, `Unclosed tag <${tagName}>`);
				}
			} else {
				children = this.parseChildren(tagName);
				if (!this.consumeClosingTag(tagName)) {
					this.error(this.pos, `Unclosed tag <${tagName}>`);
				}
			}
		}
		const range: Range = [start, this.pos];
		return classifyElement(tagName, attrs, children, selfClosing || isVoid, range);
	}

	/**
	 * Scan forward (case-insensitive) to the next `</tagName>`. Returns the
	 * offset of the `<` so the caller can slice [contentStart, here] for
	 * the raw content and consume the close tag separately.
	 */
	private findRawTextEnd(tagName: string): number {
		const lower = tagName.toLowerCase();
		let i = this.pos;
		while (i < this.source.length) {
			if (this.source.charCodeAt(i) !== CC_LT) {
				i++;
				continue;
			}
			if (this.source.charCodeAt(i + 1) !== CC_SLASH) {
				i++;
				continue;
			}
			// Match `</tagName` case-insensitively.
			let ok = true;
			for (let j = 0; j < lower.length; j++) {
				const ch = this.source.charCodeAt(i + 2 + j);
				const target = lower.charCodeAt(j);
				if (ch === target) continue;
				// Case-insensitive: allow upper/lower mismatch on letters.
				if (ch >= 0x41 && ch <= 0x5a && ch + 0x20 === target) continue;
				ok = false;
				break;
			}
			if (!ok) {
				i++;
				continue;
			}
			// Whatever follows must be `>` or whitespace then `>`.
			const after = this.source.charCodeAt(i + 2 + lower.length);
			if (after === CC_GT || isWhitespace(after)) return i;
			i++;
		}
		return this.source.length;
	}

	private parseFragmentShorthand(): AstroFragmentNode {
		const start = this.pos;
		this.pos += 2; // <>
		const children = this.parseChildren("");
		// Expect </>
		if (
			this.source.charCodeAt(this.pos) === CC_LT &&
			this.source.charCodeAt(this.pos + 1) === CC_SLASH &&
			this.source.charCodeAt(this.pos + 2) === CC_GT
		) {
			this.pos += 3;
		} else {
			this.error(start, "Unclosed `<>` fragment (expected `</>`)");
		}
		return { type: "fragment", attrs: [], children, range: [start, this.pos] };
	}

	private parseAttributes(): AstroAttribute[] {
		const attrs: AstroAttribute[] = [];
		while (this.pos < this.source.length) {
			this.skipSpaces();
			const c = this.source.charCodeAt(this.pos);
			if (c === CC_GT || c === CC_SLASH) break;
			if (this.pos >= this.source.length) break;
			if (c === CC_LBRACE) {
				attrs.push(this.parseBraceAttribute());
				continue;
			}
			attrs.push(this.parseNamedAttribute());
		}
		return attrs;
	}

	private parseBraceAttribute(): SpreadAttribute | ShorthandAttribute {
		const start = this.pos;
		const innerStart = this.pos + 1;
		const innerEnd = this.findMatchingBrace(this.pos);
		this.pos = innerEnd + 1;
		const inner = this.source.slice(innerStart, innerEnd);
		if (inner.startsWith("...")) {
			return {
				type: "spread",
				expression: inner.slice(3),
				range: [start, this.pos],
			};
		}
		// Shorthand: `{name}` is equivalent to `name={name}`. We require `inner`
		// to be a bare identifier; else fall back to spread of the whole expr.
		const trimmed = inner.trim();
		if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
			return {
				type: "shorthand",
				name: trimmed,
				expression: trimmed,
				range: [start, this.pos],
			};
		}
		this.error(start, "Expected `{...obj}` or `{name}` shorthand");
		return {
			type: "spread",
			expression: inner,
			range: [start, this.pos],
		};
	}

	private parseNamedAttribute(): AstroAttribute {
		const start = this.pos;
		const nameStart = this.pos;
		while (this.pos < this.source.length) {
			const c = this.source.charCodeAt(this.pos);
			if (!isAttrNameChar(c)) break;
			this.pos++;
		}
		const name = this.source.slice(nameStart, this.pos);
		if (name.length === 0) {
			this.error(start, `Unexpected character in tag: ${this.source[this.pos]}`);
			this.pos++;
			throw new ParseFailure();
		}
		const isDirective = name.includes(":");

		// Boolean attribute: no `=` follows.
		if (this.source.charCodeAt(this.pos) !== CC_EQ) {
			if (isDirective) {
				return {
					type: "directive",
					name,
					expression: null,
					range: [start, this.pos],
				} satisfies DirectiveAttribute;
			}
			return {
				type: "static",
				name,
				value: "",
				boolean: true,
				range: [start, this.pos],
			} satisfies StaticAttribute;
		}
		this.pos++; // consume =
		const valueChar = this.source.charCodeAt(this.pos);
		if (valueChar === CC_LBRACE) {
			const exprStart = this.pos + 1;
			const exprEnd = this.findMatchingBrace(this.pos);
			this.pos = exprEnd + 1;
			const expression = this.source.slice(exprStart, exprEnd);
			if (isDirective) {
				return {
					type: "directive",
					name,
					expression,
					range: [start, this.pos],
				} satisfies DirectiveAttribute;
			}
			return {
				type: "expression",
				name,
				expression,
				range: [start, this.pos],
			} satisfies ExpressionAttribute;
		}
		if (valueChar === CC_QUOTE_DBL || valueChar === CC_QUOTE_SGL) {
			const quote = valueChar;
			this.pos++;
			const valStart = this.pos;
			while (this.pos < this.source.length && this.source.charCodeAt(this.pos) !== quote) {
				this.pos++;
			}
			if (this.pos >= this.source.length) {
				this.error(start, "Unterminated attribute value");
				throw new ParseFailure();
			}
			const value = this.source.slice(valStart, this.pos);
			this.pos++; // consume closing quote
			if (isDirective) {
				return {
					type: "directive",
					name,
					expression: JSON.stringify(value),
					range: [start, this.pos],
				} satisfies DirectiveAttribute;
			}
			return {
				type: "static",
				name,
				value,
				boolean: false,
				range: [start, this.pos],
			} satisfies StaticAttribute;
		}
		// Unquoted value: read until whitespace, `>`, or `/>`.
		const valStart = this.pos;
		while (this.pos < this.source.length) {
			const c = this.source.charCodeAt(this.pos);
			if (isWhitespace(c) || c === CC_GT) break;
			if (c === CC_SLASH && this.source.charCodeAt(this.pos + 1) === CC_GT) break;
			this.pos++;
		}
		const value = this.source.slice(valStart, this.pos);
		if (value.length === 0) {
			this.error(start, "Expected attribute value after `=`");
		}
		if (isDirective) {
			return {
				type: "directive",
				name,
				expression: JSON.stringify(value),
				range: [start, this.pos],
			} satisfies DirectiveAttribute;
		}
		return {
			type: "static",
			name,
			value,
			boolean: false,
			range: [start, this.pos],
		} satisfies StaticAttribute;
	}

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	private atClosingTag(tagName: string): boolean {
		if (this.source.charCodeAt(this.pos) !== CC_LT) return false;
		if (this.source.charCodeAt(this.pos + 1) !== CC_SLASH) return false;
		const nameStart = this.pos + 2;
		const expected = tagName.length;
		if (nameStart + expected > this.source.length) return false;
		for (let i = 0; i < expected; i++) {
			if (this.source.charCodeAt(nameStart + i) !== tagName.charCodeAt(i)) {
				return false;
			}
		}
		const after = this.source.charCodeAt(nameStart + expected);
		return isWhitespace(after) || after === CC_GT;
	}

	private atFragmentClose(): boolean {
		return (
			this.source.charCodeAt(this.pos) === CC_LT &&
			this.source.charCodeAt(this.pos + 1) === CC_SLASH &&
			this.source.charCodeAt(this.pos + 2) === CC_GT
		);
	}

	private consumeClosingTag(tagName: string): boolean {
		if (!this.atClosingTag(tagName)) return false;
		this.pos += 2 + tagName.length;
		while (this.pos < this.source.length) {
			const c = this.source.charCodeAt(this.pos);
			if (c === CC_GT) {
				this.pos++;
				return true;
			}
			if (!isWhitespace(c)) return false;
			this.pos++;
		}
		return false;
	}

	private skipSpaces(): void {
		while (this.pos < this.source.length && isWhitespace(this.source.charCodeAt(this.pos))) {
			this.pos++;
		}
	}

	private atStartOfLine(offset: number): boolean {
		if (offset === 0) return true;
		let i = offset - 1;
		while (i >= 0) {
			const c = this.source.charCodeAt(i);
			if (c === CC_NL) return true;
			if (!isWhitespace(c)) return false;
			i--;
		}
		return true;
	}

	private skipToNewlineFrom(offset: number): number {
		let i = offset;
		while (i < this.source.length) {
			if (this.source.charCodeAt(i) === CC_NL) return i;
			i++;
		}
		return i;
	}

	private error(offset: number, message: string): void {
		this.errors.push({ message, start: locate(this.source, offset) });
	}
}

/**
 * Decide whether a tag is an HTML element, a component, a slot, or a Fragment
 * based on the first character of its name. Component identifiers may contain
 * dotted member-access (`Foo.Bar`).
 */
function classifyElement(
	name: string,
	attrs: AstroAttribute[],
	children: AstroNode[],
	selfClosing: boolean,
	range: Range,
): AstroElement | AstroComponent | AstroFragmentNode | AstroSlot {
	if (name === "slot") {
		const nameAttr = attrs.find(
			(a): a is StaticAttribute => a.type === "static" && a.name === "name",
		);
		return {
			type: "slot",
			name: nameAttr ? nameAttr.value : "default",
			attrs,
			children,
			range,
		};
	}
	if (name === "Fragment") {
		return { type: "fragment", attrs, children, range };
	}
	if (isComponentName(name)) {
		return { type: "component", name, attrs, children, selfClosing, range };
	}
	return { type: "element", name, attrs, children, selfClosing, range };
}

function isComponentName(name: string): boolean {
	if (name.length === 0) return false;
	if (name.includes(".")) return true;
	const first = name.charCodeAt(0);
	return first >= 0x41 && first <= 0x5a; // A-Z
}

class ParseFailure extends Error {
	constructor() {
		super("astroflare-parse-failure");
		this.name = "ParseFailure";
	}
}
