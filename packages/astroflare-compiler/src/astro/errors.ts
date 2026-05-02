export interface SourcePosition {
  /** 1-indexed line number. */
  line: number;
  /** 1-indexed column number. */
  column: number;
  /** 0-indexed byte offset. */
  offset: number;
}

export class AstroParseError extends Error {
  override name = "AstroParseError";
  readonly position: SourcePosition;
  readonly snippet: string;

  constructor(message: string, source: string, offset: number) {
    const position = computePosition(source, offset);
    const snippet = buildSnippet(source, position);
    super(`${message} (line ${position.line}, column ${position.column})\n${snippet}`);
    this.position = position;
    this.snippet = snippet;
  }
}

export function computePosition(source: string, offset: number): SourcePosition {
  let line = 1;
  let column = 1;
  const cap = Math.min(offset, source.length);
  for (let i = 0; i < cap; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column, offset };
}

function buildSnippet(source: string, pos: SourcePosition): string {
  // Show the offending line plus a caret.
  let lineStart = pos.offset;
  while (lineStart > 0 && source.charCodeAt(lineStart - 1) !== 10) lineStart--;
  let lineEnd = pos.offset;
  while (lineEnd < source.length && source.charCodeAt(lineEnd) !== 10) lineEnd++;
  const line = source.slice(lineStart, lineEnd);
  const caret = `${" ".repeat(Math.max(0, pos.column - 1))}^`;
  return `  ${line}\n  ${caret}`;
}
