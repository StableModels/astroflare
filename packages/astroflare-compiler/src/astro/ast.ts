export interface SourceRange {
  /** Inclusive byte offset in the original source. */
  start: number;
  /** Exclusive byte offset in the original source. */
  end: number;
}

export interface Frontmatter {
  /** The JS/TS source between the `---` fences (without the fences themselves). */
  code: string;
  range: SourceRange;
}

export type AstroAttribute =
  | { kind: "static"; name: string; value: string; quote: '"' | "'" | null; range: SourceRange }
  | { kind: "expression"; name: string; expression: string; range: SourceRange }
  | { kind: "shorthand"; name: string; range: SourceRange }
  | { kind: "spread"; expression: string; range: SourceRange }
  | { kind: "boolean"; name: string; range: SourceRange };

export type AstroNode =
  | {
      kind: "element";
      tag: string;
      attributes: AstroAttribute[];
      children: AstroNode[];
      selfClosing: boolean;
      range: SourceRange;
    }
  | {
      kind: "component";
      tag: string;
      attributes: AstroAttribute[];
      children: AstroNode[];
      selfClosing: boolean;
      range: SourceRange;
    }
  | {
      kind: "slot";
      name: string;
      attributes: AstroAttribute[];
      fallback: AstroNode[];
      range: SourceRange;
    }
  | { kind: "text"; value: string; range: SourceRange }
  | { kind: "interpolation"; expression: string; range: SourceRange }
  | { kind: "comment"; value: string; range: SourceRange }
  | { kind: "doctype"; value: string; range: SourceRange }
  | {
      kind: "raw-element";
      tag: "style" | "script";
      raw: string;
      attributes: AstroAttribute[];
      range: SourceRange;
    };

export interface AstroDocument {
  frontmatter: Frontmatter | null;
  body: AstroNode[];
  /** Source length, for sanity-checking ranges. */
  sourceLength: number;
}
