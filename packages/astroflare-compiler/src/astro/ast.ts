/**
 * AST types for `.astro`.
 *
 * The shape mirrors what an Astro `.astro` parse tree contains, simplified to
 * what we actually need for Phase 2 emission. Source positions are stored as
 * `[start, end]` byte offsets — Phase 2c provides a helper to convert offsets
 * to `{line, column}` for error messages.
 *
 * Distinction we maintain throughout:
 *   - **HTML elements**: lowercase tag names, never participate in component
 *     resolution. Attributes and children are emitted literally (with `{expr}`
 *     interpolation handled by the emitter).
 *   - **Components**: identifier references in the user's frontmatter scope.
 *     Tag name is uppercase or contains a `.` (member access). Their children
 *     are partitioned into named/default slots at emit time.
 */

export type Range = [start: number, end: number];

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface AstroDocument {
	type: "document";
	frontmatter: string | null;
	frontmatterRange: Range | null;
	body: AstroNode[];
	range: Range;
}

// ---------------------------------------------------------------------------
// Nodes (body)
// ---------------------------------------------------------------------------

export type AstroNode =
	| AstroElement
	| AstroComponent
	| AstroFragmentNode
	| AstroText
	| AstroExpression
	| AstroComment
	| AstroDoctype
	| AstroSlot;

export interface AstroElement {
	type: "element";
	name: string;
	attrs: AstroAttribute[];
	children: AstroNode[];
	selfClosing: boolean;
	range: Range;
}

export interface AstroComponent {
	type: "component";
	/**
	 * The component identifier reference, exactly as it appears in source.
	 * May be a simple identifier ("Layout") or a member-access expression
	 * ("Foo.Bar"). The emitter passes this through verbatim — the user's
	 * frontmatter is responsible for binding the name.
	 */
	name: string;
	attrs: AstroAttribute[];
	children: AstroNode[];
	selfClosing: boolean;
	range: Range;
}

/** `<Fragment>...</Fragment>` — emits its children with no wrapping element. */
export interface AstroFragmentNode {
	type: "fragment";
	attrs: AstroAttribute[];
	children: AstroNode[];
	range: Range;
}

/**
 * `<slot />` or `<slot name="...">fallback</slot>`. Inside a component body
 * this becomes a call to `$renderSlot(slots, name, fallbackFn?)`.
 */
export interface AstroSlot {
	type: "slot";
	name: string; // "default" if not specified
	attrs: AstroAttribute[];
	children: AstroNode[]; // fallback content
	range: Range;
}

export interface AstroText {
	type: "text";
	value: string;
	range: Range;
}

/** `{expression}` in content position. The expression is opaque JS source. */
export interface AstroExpression {
	type: "expression";
	expression: string;
	range: Range;
}

export interface AstroComment {
	type: "comment";
	value: string;
	range: Range;
}

export interface AstroDoctype {
	type: "doctype";
	/** The body of the doctype, e.g. "html". */
	value: string;
	range: Range;
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

export type AstroAttribute =
	| StaticAttribute
	| ExpressionAttribute
	| SpreadAttribute
	| ShorthandAttribute
	| TemplateAttribute
	| DirectiveAttribute;

/** `name="value"` or `name='value'` or boolean `name`. */
export interface StaticAttribute {
	type: "static";
	name: string;
	value: string;
	/** True for boolean attributes like `<input disabled>` (no `=value`). */
	boolean: boolean;
	range: Range;
}

/** `name={expression}`. */
export interface ExpressionAttribute {
	type: "expression";
	name: string;
	expression: string;
	range: Range;
}

/** `{...obj}`. */
export interface SpreadAttribute {
	type: "spread";
	expression: string;
	range: Range;
}

/** `{value}` shorthand — equivalent to `value={value}`. Astro feature. */
export interface ShorthandAttribute {
	type: "shorthand";
	name: string;
	expression: string;
	range: Range;
}

/** `name=`{`hello ${world}`}`. Phase 2 treats template attrs as plain expr. */
export interface TemplateAttribute {
	type: "template";
	name: string;
	expression: string;
	range: Range;
}

/**
 * Directives like `set:html`, `is:raw`, `define:vars={...}`, and client
 * directives (`client:load`, `client:idle`, `client:visible`, `client:media`,
 * `client:only`). The directive name includes the `:`.
 */
export interface DirectiveAttribute {
	type: "directive";
	name: string;
	expression: string | null;
	range: Range;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface SourceLocation {
	offset: number;
	line: number;
	column: number;
}

export interface AstroError {
	message: string;
	start: SourceLocation;
	end?: SourceLocation;
}

/** Convert a byte offset into a 1-based line/column location. */
export function locate(source: string, offset: number): SourceLocation {
	let line = 1;
	let column = 1;
	const max = Math.min(offset, source.length);
	for (let i = 0; i < max; i++) {
		if (source.charCodeAt(i) === 10 /* \n */) {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	return { offset, line, column };
}
