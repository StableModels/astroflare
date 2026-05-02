import type { AstroAttribute, AstroDocument, AstroNode, Frontmatter, SourceRange } from "./ast.js";
import { AstroParseError } from "./errors.js";

const VOID_ELEMENTS = new Set([
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
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_ELEMENTS = new Set(["style", "script"]);

export function parseAstro(source: string): AstroDocument {
  const p = new Parser(source);
  const frontmatter = p.parseFrontmatter();
  const body = p.parseChildren(null);
  return { frontmatter, body, sourceLength: source.length };
}

class Parser {
  private i = 0;
  constructor(private readonly src: string) {}

  // ---------------------------------------------------------------------
  // Frontmatter
  // ---------------------------------------------------------------------

  parseFrontmatter(): Frontmatter | null {
    const start = this.i;
    if (!this.startsWith("---")) return null;
    // The opening fence must sit at column 0 of the first non-blank line of
    // the document. We allow leading whitespace before it.
    if (this.lineUpTo(start) > 0) return null; // already past first line
    this.i += 3;
    // Optional same-line content is forbidden; require newline.
    if (this.peek() !== "\n" && this.peek() !== "\r") {
      throw new AstroParseError(
        "frontmatter opening fence must be followed by a newline",
        this.src,
        this.i,
      );
    }
    // Consume one newline (CRLF or LF).
    if (this.peek() === "\r" && this.peek(1) === "\n") this.i += 2;
    else this.i++;

    const codeStart = this.i;
    // Find a closing `---` at the start of a line.
    while (this.i < this.src.length) {
      if (this.atLineStart() && this.startsWith("---")) {
        const codeEnd = this.i;
        const code = this.src.slice(codeStart, codeEnd);
        this.i += 3;
        // Tolerate trailing whitespace + newline after the closing fence.
        while (this.peek() === " " || this.peek() === "\t") this.i++;
        if (this.peek() === "\r" && this.peek(1) === "\n") this.i += 2;
        else if (this.peek() === "\n") this.i++;
        return { code, range: { start, end: this.i } };
      }
      this.i++;
    }
    throw new AstroParseError("unterminated frontmatter — expected closing `---`", this.src, start);
  }

  // ---------------------------------------------------------------------
  // Children
  // ---------------------------------------------------------------------

  parseChildren(parentTag: string | null): AstroNode[] {
    const out: AstroNode[] = [];
    while (this.i < this.src.length) {
      // Closing tag for parent?
      if (parentTag && this.startsWith("</")) {
        const save = this.i;
        this.i += 2;
        const tag = this.tryReadIdent();
        if (tag === parentTag) {
          // Allow whitespace before `>`.
          this.skipWs();
          if (this.peek() !== ">") {
            throw new AstroParseError(`expected '>' to close </${tag}>`, this.src, this.i);
          }
          this.i++;
          return out;
        }
        // Not our closer — rewind and treat as something else (likely a text
        // glitch or a misnested tag, which we surface as text).
        this.i = save;
      }
      const node = this.parseNode();
      if (node) out.push(node);
    }
    if (parentTag) {
      throw new AstroParseError(`unterminated element <${parentTag}>`, this.src, this.i);
    }
    return out;
  }

  private parseNode(): AstroNode | null {
    const c = this.peek();
    if (c === "<") {
      if (this.startsWith("<!--")) return this.parseComment();
      if (this.startsWithCI("<!doctype")) return this.parseDoctype();
      const next = this.peek(1);
      if (next === "/" || !isTagStart(next)) {
        // Stray `<`: emit as text up through this char.
        return this.consumeTextLike();
      }
      return this.parseElement();
    }
    if (c === "{") return this.parseInterpolation();
    return this.consumeTextLike();
  }

  // ---------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------

  private consumeTextLike(): AstroNode | null {
    const start = this.i;
    while (this.i < this.src.length) {
      const c = this.peek();
      if (c === "<" || c === "{") break;
      this.i++;
    }
    if (this.i === start) {
      // Single delimiter we couldn't classify as a real node — bump past it as text
      // so we always make progress.
      this.i++;
    }
    if (this.i === start) return null;
    return {
      kind: "text",
      value: this.src.slice(start, this.i),
      range: { start, end: this.i },
    };
  }

  // ---------------------------------------------------------------------
  // Comment / doctype
  // ---------------------------------------------------------------------

  private parseComment(): AstroNode {
    const start = this.i;
    this.i += 4; // <!--
    const valueStart = this.i;
    while (this.i < this.src.length && !this.startsWith("-->")) this.i++;
    if (this.i >= this.src.length) {
      throw new AstroParseError("unterminated HTML comment", this.src, start);
    }
    const value = this.src.slice(valueStart, this.i);
    this.i += 3;
    return { kind: "comment", value, range: { start, end: this.i } };
  }

  private parseDoctype(): AstroNode {
    const start = this.i;
    while (this.i < this.src.length && this.peek() !== ">") this.i++;
    if (this.peek() !== ">") {
      throw new AstroParseError("unterminated DOCTYPE", this.src, start);
    }
    this.i++;
    const value = this.src.slice(start, this.i);
    return { kind: "doctype", value, range: { start, end: this.i } };
  }

  // ---------------------------------------------------------------------
  // Interpolation
  // ---------------------------------------------------------------------

  private parseInterpolation(): AstroNode {
    const start = this.i;
    this.i++; // skip {
    const exprStart = this.i;
    this.scanBalancedExpression(start);
    const expression = this.src.slice(exprStart, this.i);
    this.i++; // skip closing }
    return {
      kind: "interpolation",
      expression,
      range: { start, end: this.i },
    };
  }

  // ---------------------------------------------------------------------
  // Element
  // ---------------------------------------------------------------------

  private parseElement(): AstroNode {
    const start = this.i;
    this.i++; // skip <
    const tag = this.readTagName(start);
    const attributes = this.parseAttributes(tag, start);
    this.skipWs();
    let selfClosing = false;
    if (this.peek() === "/") {
      selfClosing = true;
      this.i++;
    }
    if (this.peek() !== ">") {
      throw new AstroParseError(
        `expected '>' or '/>' to end <${tag}> opening tag`,
        this.src,
        this.i,
      );
    }
    this.i++;

    const isComponent = isComponentTag(tag);
    const isSlot = tag === "slot";
    const isVoid = !isComponent && VOID_ELEMENTS.has(tag);
    const isRaw = !isComponent && RAW_ELEMENTS.has(tag);

    if (selfClosing || isVoid) {
      const range: SourceRange = { start, end: this.i };
      if (isSlot) {
        return {
          kind: "slot",
          name: extractSlotName(attributes),
          attributes: stripSlotName(attributes),
          fallback: [],
          range,
        };
      }
      if (isComponent) {
        return {
          kind: "component",
          tag,
          attributes,
          children: [],
          selfClosing: true,
          range,
        };
      }
      return {
        kind: "element",
        tag,
        attributes,
        children: [],
        selfClosing: true,
        range,
      };
    }

    if (isRaw) {
      const raw = this.consumeRawUntilClose(tag);
      return {
        kind: "raw-element",
        tag: tag as "style" | "script",
        raw,
        attributes,
        range: { start, end: this.i },
      };
    }

    const children = this.parseChildren(tag);
    const range: SourceRange = { start, end: this.i };
    if (isSlot) {
      return {
        kind: "slot",
        name: extractSlotName(attributes),
        attributes: stripSlotName(attributes),
        fallback: children,
        range,
      };
    }
    if (isComponent) {
      return { kind: "component", tag, attributes, children, selfClosing: false, range };
    }
    return { kind: "element", tag, attributes, children, selfClosing: false, range };
  }

  private consumeRawUntilClose(tag: string): string {
    const start = this.i;
    const closing = `</${tag}`;
    while (this.i < this.src.length) {
      // Match closing tag, case-insensitive on the tag name.
      if (this.src.slice(this.i, this.i + closing.length).toLowerCase() === closing.toLowerCase()) {
        const raw = this.src.slice(start, this.i);
        this.i += closing.length;
        this.skipWs();
        if (this.peek() !== ">") {
          throw new AstroParseError(`expected '>' to close </${tag}>`, this.src, this.i);
        }
        this.i++;
        return raw;
      }
      this.i++;
    }
    throw new AstroParseError(`unterminated <${tag}> block`, this.src, start);
  }

  // ---------------------------------------------------------------------
  // Attributes
  // ---------------------------------------------------------------------

  private parseAttributes(tag: string, tagStart: number): AstroAttribute[] {
    const out: AstroAttribute[] = [];
    while (this.i < this.src.length) {
      this.skipWs();
      const c = this.peek();
      if (c === ">" || c === "/" || c === "") break;
      const attrStart = this.i;
      if (c === "{") {
        // Either {...spread} or {shorthand}
        this.i++; // skip {
        this.skipWs();
        if (this.startsWith("...")) {
          this.i += 3;
          const exprStart = this.i;
          this.scanBalancedExpression(attrStart);
          const expression = this.src.slice(exprStart, this.i).trim();
          this.i++; // skip }
          out.push({
            kind: "spread",
            expression,
            range: { start: attrStart, end: this.i },
          });
          continue;
        }
        // Shorthand: {name} where name is a valid JS identifier.
        const exprStart = this.i;
        this.scanBalancedExpression(attrStart);
        const inner = this.src.slice(exprStart, this.i).trim();
        this.i++; // skip }
        if (!isIdent(inner)) {
          // Not a valid shorthand — could be a stray expression like `{ foo() }`.
          // Astro treats this as an expression attribute with the same name as
          // the expression, but for our subset we require an identifier.
          throw new AstroParseError(
            `attribute shorthand must be an identifier (got '${inner}')`,
            this.src,
            attrStart,
          );
        }
        out.push({
          kind: "shorthand",
          name: inner,
          range: { start: attrStart, end: this.i },
        });
        continue;
      }
      const name = this.readAttrName(tag, tagStart);
      // Check for `=value`
      if (this.peek() !== "=") {
        out.push({
          kind: "boolean",
          name,
          range: { start: attrStart, end: this.i },
        });
        continue;
      }
      this.i++; // skip =
      const valC = this.peek();
      if (valC === '"' || valC === "'") {
        const quote = valC as '"' | "'";
        this.i++;
        const valStart = this.i;
        while (this.i < this.src.length && this.peek() !== quote) this.i++;
        if (this.peek() !== quote) {
          throw new AstroParseError(
            `unterminated ${quote === '"' ? "double" : "single"}-quoted attribute value`,
            this.src,
            attrStart,
          );
        }
        const value = this.src.slice(valStart, this.i);
        this.i++; // closing quote
        out.push({
          kind: "static",
          name,
          value,
          quote,
          range: { start: attrStart, end: this.i },
        });
        continue;
      }
      if (valC === "{") {
        const exprFenceStart = this.i;
        this.i++;
        const exprStart = this.i;
        this.scanBalancedExpression(exprFenceStart);
        const expression = this.src.slice(exprStart, this.i);
        this.i++; // }
        out.push({
          kind: "expression",
          name,
          expression,
          range: { start: attrStart, end: this.i },
        });
        continue;
      }
      // Unquoted value (HTML legacy). Read until whitespace or '>' or '/'.
      const valStart = this.i;
      while (
        this.i < this.src.length &&
        !isWs(this.peek()) &&
        this.peek() !== ">" &&
        this.peek() !== "/"
      ) {
        this.i++;
      }
      const value = this.src.slice(valStart, this.i);
      if (value.length === 0) {
        throw new AstroParseError(
          `expected a value after '=' for attribute '${name}'`,
          this.src,
          attrStart,
        );
      }
      out.push({
        kind: "static",
        name,
        value,
        quote: null,
        range: { start: attrStart, end: this.i },
      });
    }
    return out;
  }

  private readAttrName(tag: string, tagStart: number): string {
    const start = this.i;
    while (this.i < this.src.length) {
      const c = this.peek();
      if (
        isWs(c) ||
        c === ">" ||
        c === "/" ||
        c === "=" ||
        c === '"' ||
        c === "'" ||
        c === "<" ||
        c === ""
      ) {
        break;
      }
      this.i++;
    }
    if (this.i === start) {
      throw new AstroParseError(`expected an attribute name in <${tag}>`, this.src, tagStart);
    }
    return this.src.slice(start, this.i);
  }

  // ---------------------------------------------------------------------
  // Tag name reading
  // ---------------------------------------------------------------------

  private readTagName(tagStart: number): string {
    const start = this.i;
    while (this.i < this.src.length) {
      const c = this.peek();
      if (c === ">" || c === "/" || c === "=" || c === '"' || c === "'" || c === "<" || c === "") {
        break;
      }
      if (isWs(c)) break;
      this.i++;
    }
    if (this.i === start) {
      throw new AstroParseError("expected a tag name after '<'", this.src, tagStart);
    }
    return this.src.slice(start, this.i);
  }

  private tryReadIdent(): string {
    const start = this.i;
    while (this.i < this.src.length) {
      const c = this.peek();
      if (isWs(c) || c === ">" || c === "/" || c === "<" || c === "") break;
      this.i++;
    }
    return this.src.slice(start, this.i);
  }

  // ---------------------------------------------------------------------
  // Expression scanning — finds the matching closing `}` for a `{` we just
  // consumed at `outerStart`, respecting JS strings, template literals, regex
  // literals (best-effort), and line/block comments.
  // ---------------------------------------------------------------------

  private scanBalancedExpression(outerStart: number): void {
    let depth = 1;
    while (this.i < this.src.length) {
      const c = this.peek();
      if (c === "{") {
        depth++;
        this.i++;
        continue;
      }
      if (c === "}") {
        depth--;
        if (depth === 0) return;
        this.i++;
        continue;
      }
      if (c === '"' || c === "'") {
        this.skipString(c);
        continue;
      }
      if (c === "`") {
        this.skipTemplate();
        continue;
      }
      if (c === "/" && this.peek(1) === "/") {
        while (this.i < this.src.length && this.peek() !== "\n") this.i++;
        continue;
      }
      if (c === "/" && this.peek(1) === "*") {
        this.i += 2;
        while (this.i < this.src.length && !this.startsWith("*/")) this.i++;
        if (this.startsWith("*/")) this.i += 2;
        continue;
      }
      this.i++;
    }
    throw new AstroParseError(
      "unterminated expression — missing closing '}'",
      this.src,
      outerStart,
    );
  }

  private skipString(quote: string): void {
    this.i++; // opening quote
    while (this.i < this.src.length) {
      const c = this.peek();
      if (c === "\\") {
        this.i += 2;
        continue;
      }
      if (c === quote) {
        this.i++;
        return;
      }
      if (c === "\n") {
        throw new AstroParseError("unterminated string literal in expression", this.src, this.i);
      }
      this.i++;
    }
    throw new AstroParseError("unterminated string literal in expression", this.src, this.i);
  }

  private skipTemplate(): void {
    this.i++; // opening backtick
    while (this.i < this.src.length) {
      const c = this.peek();
      if (c === "\\") {
        this.i += 2;
        continue;
      }
      if (c === "`") {
        this.i++;
        return;
      }
      if (c === "$" && this.peek(1) === "{") {
        this.i += 2;
        let depth = 1;
        while (this.i < this.src.length && depth > 0) {
          const cc = this.peek();
          if (cc === "{") depth++;
          else if (cc === "}") {
            depth--;
            if (depth === 0) {
              this.i++;
              break;
            }
          } else if (cc === "`") {
            this.skipTemplate();
            continue;
          } else if (cc === '"' || cc === "'") {
            this.skipString(cc);
            continue;
          }
          this.i++;
        }
        continue;
      }
      this.i++;
    }
    throw new AstroParseError("unterminated template literal", this.src, this.i);
  }

  // ---------------------------------------------------------------------
  // Char helpers
  // ---------------------------------------------------------------------

  private peek(offset = 0): string {
    return this.src[this.i + offset] ?? "";
  }

  private startsWith(s: string): boolean {
    return this.src.startsWith(s, this.i);
  }

  private startsWithCI(s: string): boolean {
    return this.src.slice(this.i, this.i + s.length).toLowerCase() === s.toLowerCase();
  }

  private skipWs(): void {
    while (this.i < this.src.length && isWs(this.peek())) this.i++;
  }

  private atLineStart(): boolean {
    return this.i === 0 || this.src.charCodeAt(this.i - 1) === 10;
  }

  private lineUpTo(offset: number): number {
    let n = 0;
    for (let k = 0; k < offset; k++) {
      if (this.src.charCodeAt(k) === 10) n++;
    }
    return n;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTagStart(c: string): boolean {
  return /[A-Za-z!]/.test(c);
}

function isWs(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function isIdent(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s);
}

export function isComponentTag(tag: string): boolean {
  // Capitalised first char OR contains '.' (member access like Foo.Bar).
  if (tag.length === 0) return false;
  if (tag[0] === undefined) return false;
  if (tag.includes(".")) return true;
  const first = tag[0];
  return first >= "A" && first <= "Z";
}

function extractSlotName(attrs: AstroAttribute[]): string {
  const a = attrs.find((x) => (x.kind === "static" || x.kind === "boolean") && x.name === "name");
  if (!a) return "default";
  if (a.kind === "static") return a.value;
  return "default";
}

function stripSlotName(attrs: AstroAttribute[]): AstroAttribute[] {
  return attrs.filter((x) => !((x.kind === "static" || x.kind === "boolean") && x.name === "name"));
}
