import type { AstroAttribute, AstroDocument, AstroNode } from "./ast.js";
import { isComponentTag } from "./parser.js";

export interface EmitOptions {
  /**
   * Included as a comment in the emitted output for debugging. Not used for
   * runtime resolution.
   */
  filename?: string;
}

export interface EmitResult {
  code: string;
}

/**
 * Emit an ESM module for an `.astro` document.
 *
 * The default export matches Astro's contract: a render function with the
 * signature `(result, props, slots) => Promise<string>`. `result` is the
 * runtime helper bag — it carries `escape`, `attr`, `attrs`, `renderComponent`,
 * `renderSlot`, and `createComponent`. `slots` is a record of named functions
 * each producing a slot fragment as a string.
 *
 * Imports declared inside the frontmatter are hoisted to module top-level so
 * that ESM resolution works as expected. Other frontmatter code becomes the
 * body of the render function so it has access to `props`.
 */
export function emit(doc: AstroDocument, opts: EmitOptions = {}): EmitResult {
  const e = new Emitter();
  const fm = doc.frontmatter ? splitFrontmatter(doc.frontmatter.code) : { imports: "", body: "" };

  let out = "";
  if (opts.filename) out += `// astroflare-compiled: ${opts.filename}\n`;
  if (fm.imports) {
    out += fm.imports;
    if (!fm.imports.endsWith("\n")) out += "\n";
  }
  out += "export default async function $$render(result, props, slots) {\n";
  out += "  const $$result = result;\n";
  out += "  const $$props = props;\n";
  out += "  const $$slots = slots ?? {};\n";
  if (fm.body.trim().length > 0) {
    out += indent(fm.body, "  ");
    if (!fm.body.endsWith("\n")) out += "\n";
  }
  out += '  let $$out = "";\n';
  for (const child of doc.body) {
    out += e.emitNode(child, "  ");
  }
  out += "  return $$out;\n";
  out += "}\n";
  return { code: out };
}

class Emitter {
  emitNode(node: AstroNode, indent: string): string {
    switch (node.kind) {
      case "text":
        return `${indent}$$out += ${quote(node.value)};\n`;
      case "doctype":
        return `${indent}$$out += ${quote(node.value)};\n`;
      case "comment":
        return `${indent}$$out += ${quote(`<!--${node.value}-->`)};\n`;
      case "interpolation":
        return `${indent}$$out += $$result.escape(${node.expression});\n`;
      case "raw-element":
        return this.emitRawElement(node, indent);
      case "element":
        return this.emitElement(node, indent);
      case "component":
        return this.emitComponent(node, indent);
      case "slot":
        return this.emitSlot(node, indent);
    }
  }

  private emitRawElement(
    node: Extract<AstroNode, { kind: "raw-element" }>,
    indent: string,
  ): string {
    let out = "";
    out += `${indent}$$out += ${quote(`<${node.tag}`)};\n`;
    out += this.emitElementAttributes(node.attributes, indent);
    out += `${indent}$$out += ">";\n`;
    out += `${indent}$$out += ${quote(node.raw)};\n`;
    out += `${indent}$$out += ${quote(`</${node.tag}>`)};\n`;
    return out;
  }

  private emitElement(node: Extract<AstroNode, { kind: "element" }>, indent: string): string {
    const directives = collectDirectives(node.attributes);
    let out = "";

    if (directives.setHtml) {
      out += `${indent}$$out += ${quote(`<${node.tag}`)};\n`;
      out += this.emitElementAttributes(directives.rest, indent);
      out += `${indent}$$out += ">";\n`;
      out += `${indent}$$out += String(${directives.setHtml.expression} ?? "");\n`;
      if (!node.selfClosing) {
        out += `${indent}$$out += ${quote(`</${node.tag}>`)};\n`;
      }
      return out;
    }

    out += `${indent}$$out += ${quote(`<${node.tag}`)};\n`;
    out += this.emitElementAttributes(directives.rest, indent);
    if (node.selfClosing) {
      // For real HTML void elements we want `<br>`, but if the user wrote
      // `<br />` we keep their style.
      out += `${indent}$$out += ">";\n`;
      return out;
    }
    out += `${indent}$$out += ">";\n`;
    if (directives.isRaw) {
      const raw = renderRawChildren(node.children);
      out += `${indent}$$out += ${quote(raw)};\n`;
    } else {
      for (const child of node.children) {
        out += this.emitNode(child, indent);
      }
    }
    out += `${indent}$$out += ${quote(`</${node.tag}>`)};\n`;
    return out;
  }

  private emitElementAttributes(attrs: AstroAttribute[], indent: string): string {
    let out = "";
    for (const a of attrs) {
      switch (a.kind) {
        case "static": {
          // Render literal — use double quotes regardless of source quote.
          out += `${indent}$$out += ${quote(` ${a.name}="${escapeAttr(a.value)}"`)};\n`;
          break;
        }
        case "boolean": {
          out += `${indent}$$out += ${quote(` ${a.name}`)};\n`;
          break;
        }
        case "expression": {
          out += `${indent}$$out += $$result.attr(${quote(a.name)}, ${a.expression});\n`;
          break;
        }
        case "shorthand": {
          out += `${indent}$$out += $$result.attr(${quote(a.name)}, ${a.name});\n`;
          break;
        }
        case "spread": {
          out += `${indent}$$out += $$result.attrs(${a.expression});\n`;
          break;
        }
      }
    }
    return out;
  }

  private emitComponent(node: Extract<AstroNode, { kind: "component" }>, indent: string): string {
    const propsExpr = buildPropsExpression(node.attributes);
    const slotsExpr = this.buildSlotsExpression(node.children, indent);
    return `${indent}$$out += await $$result.renderComponent(${node.tag}, ${propsExpr}, ${slotsExpr});\n`;
  }

  private emitSlot(node: Extract<AstroNode, { kind: "slot" }>, indent: string): string {
    let fallbackExpr = "undefined";
    if (node.fallback.length > 0) {
      const inner = this.emitChildrenAsFunction(node.fallback, `${indent}  `);
      fallbackExpr = inner;
    }
    return `${indent}$$out += await $$result.renderSlot($$slots, ${quote(node.name)}, ${fallbackExpr});\n`;
  }

  private buildSlotsExpression(children: AstroNode[], indent: string): string {
    // Group children by their slot="..." attribute on top-level elements.
    const groups = new Map<string, AstroNode[]>();
    groups.set("default", []);
    for (const c of children) {
      const slotName = topLevelSlotName(c) ?? "default";
      let bucket = groups.get(slotName);
      if (!bucket) {
        bucket = [];
        groups.set(slotName, bucket);
      }
      bucket.push(c);
    }
    const entries: string[] = [];
    for (const [name, nodes] of groups) {
      if (nodes.length === 0) continue;
      const fn = this.emitChildrenAsFunction(nodes, `${indent}  `);
      entries.push(`${quoteKey(name)}: ${fn}`);
    }
    if (entries.length === 0) return "{}";
    return `{ ${entries.join(", ")} }`;
  }

  private emitChildrenAsFunction(children: AstroNode[], indent: string): string {
    let inner = "";
    inner += "async () => {\n";
    inner += `${indent}let $$out = "";\n`;
    for (const child of children) {
      inner += this.emitNode(stripTopLevelSlotAttr(child), indent);
    }
    inner += `${indent}return $$out;\n`;
    inner += `${indent.slice(0, -2)}}`;
    return inner;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function topLevelSlotName(node: AstroNode): string | null {
  if (node.kind !== "element" && node.kind !== "component") return null;
  const a = node.attributes.find(
    (x) => (x.kind === "static" || x.kind === "boolean") && x.name === "slot",
  );
  if (!a) return null;
  if (a.kind === "static") return a.value;
  return null;
}

function stripTopLevelSlotAttr(node: AstroNode): AstroNode {
  if (node.kind !== "element" && node.kind !== "component") return node;
  if (!node.attributes.some((x) => x.kind === "static" && x.name === "slot")) return node;
  return {
    ...node,
    attributes: node.attributes.filter((x) => !(x.kind === "static" && x.name === "slot")),
  };
}

function buildPropsExpression(attrs: AstroAttribute[]): string {
  const parts: string[] = [];
  for (const a of attrs) {
    if (a.kind === "static") {
      parts.push(`${quoteKey(a.name)}: ${quote(a.value)}`);
    } else if (a.kind === "boolean") {
      parts.push(`${quoteKey(a.name)}: true`);
    } else if (a.kind === "expression") {
      parts.push(`${quoteKey(a.name)}: (${a.expression})`);
    } else if (a.kind === "shorthand") {
      parts.push(`${quoteKey(a.name)}: ${a.name}`);
    } else if (a.kind === "spread") {
      parts.push(`...(${a.expression})`);
    }
  }
  return `{ ${parts.join(", ")} }`;
}

interface DirectiveSplit {
  setHtml: { expression: string } | null;
  isRaw: boolean;
  rest: AstroAttribute[];
}

function collectDirectives(attrs: AstroAttribute[]): DirectiveSplit {
  let setHtml: { expression: string } | null = null;
  let isRaw = false;
  const rest: AstroAttribute[] = [];
  for (const a of attrs) {
    if (a.kind === "expression" && a.name === "set:html") {
      setHtml = { expression: a.expression };
      continue;
    }
    if (a.kind === "static" && a.name === "set:html") {
      // set:html="literal" — tolerate by emitting as a raw string.
      setHtml = { expression: JSON.stringify(a.value) };
      continue;
    }
    if (a.kind === "boolean" && a.name === "is:raw") {
      isRaw = true;
      continue;
    }
    rest.push(a);
  }
  return { setHtml, isRaw, rest };
}

function renderRawChildren(children: AstroNode[]): string {
  let out = "";
  for (const child of children) {
    if (child.kind === "text") out += child.value;
    else if (child.kind === "interpolation") out += `{${child.expression}}`;
    else if (child.kind === "comment") out += `<!--${child.value}-->`;
    else {
      // Re-stringify; this is a best-effort for `is:raw`. A full implementation
      // would round-trip the original source via ranges — defer to a follow-up.
      out += "";
    }
  }
  return out;
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function quoteKey(name: string): string {
  // Object key — bare identifier when valid, JSON-quoted otherwise.
  if (/^[A-Za-z_$][\w$]*$/.test(name)) return name;
  return JSON.stringify(name);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function indent(code: string, prefix: string): string {
  return code
    .split("\n")
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Frontmatter splitting: hoist top-level `import`/`export` declarations to the
// module scope and keep the rest as render-function body.
// ---------------------------------------------------------------------------

function splitFrontmatter(code: string): { imports: string; body: string } {
  // Match line-leading `import ...;` and `export ... from '...';`.
  // We also accept multi-line imports by walking until a `;` at brace-depth 0.
  const imports: string[] = [];
  const bodyParts: string[] = [];
  let i = 0;
  while (i < code.length) {
    // Skip leading whitespace on a line, find the line start position.
    const lineStart = i;
    while (i < code.length && (code[i] === " " || code[i] === "\t")) i++;
    if (
      code.startsWith("import ", i) ||
      code.startsWith("import{", i) ||
      code.startsWith("import*", i) ||
      code.startsWith('import"', i) ||
      code.startsWith("import'", i)
    ) {
      const stmtEnd = findStatementEnd(code, i);
      imports.push(code.slice(i, stmtEnd));
      i = stmtEnd;
      // Consume trailing newline so we don't leave a blank line in the body.
      if (code[i] === "\n") i++;
      continue;
    }
    // Not an import — restore to lineStart and copy the rest of the line into body.
    i = lineStart;
    const lineEnd = code.indexOf("\n", i);
    const end = lineEnd === -1 ? code.length : lineEnd + 1;
    bodyParts.push(code.slice(i, end));
    i = end;
  }
  return {
    imports: imports.join("\n"),
    body: bodyParts.join(""),
  };
}

function findStatementEnd(code: string, start: number): number {
  // Walk to the next `;` at brace-depth 0, skipping strings/template-literals.
  let i = start;
  let depth = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < code.length) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === c) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      while (i < code.length && code[i] !== "`") {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ";" && depth === 0) return i + 1;
    else if (c === "\n" && depth === 0) {
      // Allow imports without a trailing semicolon — terminate at newline.
      return i;
    }
    i++;
  }
  return i;
}
