/**
 * Hand-rolled `.astro` parser.
 *
 * Single-pass recursive descent. No tokenization phase — for HTML-with-JSX-
 * expressions the boundaries between text, tags, and `{...}` are unambiguous
 * once we're tracking string/comment/bracket state inside expressions, so a
 * separate token stream is just a layer of indirection.
 *
 * Produces an `AstroDocument` plus a list of recoverable `AstroError`s. The
 * parser tries hard to keep going past errors so editor tooling can still
 * highlight the rest of the file; severe structural errors (unclosed comment,
 * unclosed expression brace, runaway string) throw immediately.
 *
 * Tier 0 grammar (per §3 of the brief):
 *   - frontmatter: `---\n ... \n---` at top of file (whitespace-tolerant)
 *   - HTML elements with attributes (static / expression / spread / shorthand / directive)
 *   - components (uppercase or dotted tag name)
 *   - `<slot>`, `<slot name="...">`, fallback content
 *   - `<Fragment>` / `<>...<>` (empty-tag fragment shorthand)
 *   - `{expr}` interpolation in content and attribute positions
 *   - `<!-- comment -->`, `<!DOCTYPE html>`
 *   - `set:html`, `is:raw`, `define:vars`, `client:*` directives (parsed; emit
 *     decisions belong to the emitter)
 */
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
const CC_QUOTE_DBL = 0x22;
const CC_QUOTE_SGL = 0x27;
const CC_BACKTICK = 0x60;
const CC_BACKSLASH = 0x5c;
const CC_EQ = 0x3d;
const CC_DOLLAR = 0x24;
const CC_STAR = 0x2a;
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

function isWordChar(c: number): boolean {
	// JS identifier-ish: ASCII letters, digits, `_`, `$`. Good-enough for
	// the regex-vs-division heuristic; full Unicode identifiers don't show
	// up in the contexts that bite.
	return (
		(c >= 0x30 && c <= 0x39) || // 0-9
		(c >= 0x41 && c <= 0x5a) || // A-Z
		(c >= 0x61 && c <= 0x7a) || // a-z
		c === 0x5f /* _ */ ||
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
	 * Walks through string literals (single, double, backtick with `${}`),
	 * line and block comments, and balanced parens / brackets / braces.
	 *
	 * Known limitation: regex literals are not disambiguated from division.
	 * In practice expressions in attributes/content don't usually contain
	 * standalone regex literals; if one bites, we add a heuristic.
	 */
	private findMatchingBrace(openPos: number): number {
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
				case CC_QUOTE_SGL:
					i = this.skipString(i, c);
					break;
				case CC_BACKTICK:
					i = this.skipTemplateString(i);
					break;
				case CC_SLASH:
					if (this.source.charCodeAt(i + 1) === CC_SLASH) {
						i = this.skipLineComment(i);
					} else if (this.source.charCodeAt(i + 1) === CC_STAR) {
						i = this.skipBlockComment(i);
					} else if (this.isRegexStart(i, openPos)) {
						i = this.skipRegexLiteral(i);
					} else {
						i++;
					}
					break;
				default:
					i++;
			}
		}
		this.error(openPos, "Unclosed expression (missing `}`)");
		throw new ParseFailure();
	}

	private skipString(start: number, quote: number): number {
		let i = start + 1;
		while (i < this.source.length) {
			const c = this.source.charCodeAt(i);
			if (c === CC_BACKSLASH) {
				i += 2;
				continue;
			}
			if (c === quote) return i + 1;
			if (c === CC_NL && quote !== CC_BACKTICK) {
				this.error(start, "Unterminated string literal");
				throw new ParseFailure();
			}
			i++;
		}
		this.error(start, "Unterminated string literal");
		throw new ParseFailure();
	}

	private skipTemplateString(start: number): number {
		let i = start + 1;
		while (i < this.source.length) {
			const c = this.source.charCodeAt(i);
			if (c === CC_BACKSLASH) {
				i += 2;
				continue;
			}
			if (c === CC_BACKTICK) return i + 1;
			if (c === CC_DOLLAR && this.source.charCodeAt(i + 1) === CC_LBRACE) {
				const end = this.findMatchingBrace(i + 1);
				i = end + 1;
				continue;
			}
			i++;
		}
		this.error(start, "Unterminated template literal");
		throw new ParseFailure();
	}

	private skipLineComment(start: number): number {
		let i = start + 2;
		while (i < this.source.length) {
			const c = this.source.charCodeAt(i);
			if (c === CC_NL) return i + 1;
			i++;
		}
		return i;
	}

	/**
	 * Heuristic: is the `/` at `pos` the start of a regex literal (not
	 * division)? We're inside an expression that began at `openPos`. JS
	 * uses the preceding context to decide:
	 *   - At the very start of the expression, `/` is regex.
	 *   - After an operator or punctuation that can't be followed by a
	 *     value (`=`, `(`, `,`, `[`, `{`, `;`, `:`, `!`, `&`, `|`, `?`,
	 *     `+`, `-`, `*`, `%`, `<`, `>`, `^`, `~`, `/`, `\n`), `/` is regex.
	 *   - After certain keywords (`return`, `typeof`, `in`, `of`,
	 *     `instanceof`, `new`, `delete`, `throw`, `void`, `yield`, `await`),
	 *     `/` is regex.
	 *   - Otherwise it's division.
	 *
	 * Imperfect (a real JS tokenizer is required for full correctness),
	 * but covers the cases that bite in practice — most notably regexes
	 * containing `}` like `/[}]/` which would otherwise truncate the
	 * expression body.
	 *
	 * JSX-tag short-circuit: a `/` immediately following `<` or `>` (no
	 * whitespace between) is never a regex in `.astro` expression
	 * context — it's the slash of a JSX closing tag (`</li>`) or the
	 * leading slash of JSX text between sibling tags (`<Tag>/lit/`).
	 * Without this, the canonical Astro list-rendering idiom
	 * `{items.map((x) => (<li>{x}</li>))}` blows up: the `<` before
	 * `/li>` matches the `<` arm of the switch below, the regex skipper
	 * runs off the end of the source, and the brace counter never
	 * unwinds. The walk-back loop intentionally requires no whitespace
	 * between the tag-boundary char and the `/` so that JS like
	 * `a < /pattern/.test(s)` (with the conventional space) still parses
	 * as comparison + regex.
	 */
	private isRegexStart(slashPos: number, openPos: number): boolean {
		const adj = this.source.charCodeAt(slashPos - 1);
		if (adj === CC_LT || adj === CC_GT) return false;
		// Walk back skipping whitespace and comments.
		let j = slashPos - 1;
		while (j > openPos) {
			const c = this.source.charCodeAt(j);
			if (isWhitespace(c)) {
				j--;
				continue;
			}
			break;
		}
		// At the very start of the expression body? Definitely regex.
		if (j <= openPos) return true;
		const c = this.source.charCodeAt(j);
		// Punctuation / operator chars that allow a regex to follow.
		switch (c) {
			case CC_EQ:
			case CC_LPAREN:
			case CC_LBRACK:
			case CC_LBRACE:
			case 0x2c: // ,
			case 0x3b: // ;
			case 0x3a: // :
			case CC_BANG:
			case 0x26: // &
			case 0x7c: // |
			case 0x3f: // ?
			case 0x2b: // +
			case CC_DASH:
			case CC_STAR:
			case 0x25: // %
			case 0x3c: // <
			case 0x3e: // >
			case 0x5e: // ^
			case 0x7e: // ~
			case CC_SLASH:
				return true;
		}
		// Identifier/keyword preceding? Walk back to the start.
		if (isWordChar(c)) {
			let k = j;
			while (k > openPos && isWordChar(this.source.charCodeAt(k - 1))) k--;
			const word = this.source.slice(k, j + 1);
			return REGEX_PRECEDING_KEYWORDS.has(word);
		}
		// Anything else (`)`, `]`, digit, identifier handled above): division.
		return false;
	}

	/**
	 * Walk forward from a `/` known to start a regex literal. Handles
	 * `[...]` character classes (where `/` is a literal slash) and
	 * backslash escapes. Returns the index just past the closing `/` and
	 * any flag chars (`gimsuy`).
	 */
	private skipRegexLiteral(start: number): number {
		let i = start + 1;
		let inCharClass = false;
		while (i < this.source.length) {
			const c = this.source.charCodeAt(i);
			if (c === CC_BACKSLASH) {
				i += 2;
				continue;
			}
			if (c === 0x5b /* [ */) {
				inCharClass = true;
				i++;
				continue;
			}
			if (c === 0x5d /* ] */ && inCharClass) {
				inCharClass = false;
				i++;
				continue;
			}
			if (c === CC_SLASH && !inCharClass) {
				i++;
				// Consume flag chars.
				while (i < this.source.length) {
					const f = this.source.charCodeAt(i);
					if (f >= 0x61 /* a */ && f <= 0x7a /* z */) {
						i++;
					} else break;
				}
				return i;
			}
			if (c === CC_NL) {
				// Unterminated regex — bail out, treat the `/` as division
				// from the original position (caller picked up only one char).
				return start + 1;
			}
			i++;
		}
		return start + 1;
	}

	private skipBlockComment(start: number): number {
		let i = start + 2;
		while (i < this.source.length - 1) {
			if (this.source.charCodeAt(i) === CC_STAR && this.source.charCodeAt(i + 1) === CC_SLASH) {
				return i + 2;
			}
			i++;
		}
		this.error(start, "Unterminated block comment");
		throw new ParseFailure();
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
