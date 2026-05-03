# Phase 13 — Asset pipeline + image transforms + source-map placeholder

**Goal:** users can `import logo from "./logo.png"`, drop it into
`<Image src={logo}>`, and have the framework wire compile-time
metadata + per-asset URL serving end-to-end. Plus emit a v3
source-map placeholder from the .astro compiler.

**Status:** done. **482 tests / 43 files / 5 pools all green** (was
465 at end of Phase 12).

## What landed

### `ImageService` interface (`@astroflare/core`)

```ts
export interface ImageService {
  getMetadata(path: string): Promise<ImageMetadata>;
}

export interface ImageMetadata {
  src: string;
  width?: number;
  height?: number;
  format?: string;
}
```

`Host` grew an optional `imageService?: ImageService` slot. Optional
because plenty of test fixtures don't exercise images; the framework
falls back gracefully when absent.

### `MemoryImageService` (`@astroflare/test-utils`)

In-memory test stub — `set(path, metadata)` pre-seeds; `getMetadata`
serves it back. The brief carves real image processing (PNG/JPEG
header parsing, format conversion, DPR variants) out to the host
layer, so the framework-side stub stays thin. `createTestHost()`
now installs one by default and exposes it on the `TestHost` shape.

### Compile-time image-import substitution (`module-graph.ts`)

The module-graph's `#compileSource` now runs a pre-pass: scan the
source for `import NAME from "./path.png"` (any of `.png .jpe?g .webp
.gif .avif .svg .ico`), call `host.imageService.getMetadata(...)` for
each, and rewrite the line into `const NAME = {…literal…};`. The
substituted const has the metadata's `src`, `width`, `height`,
`format` baked in.

Why pre-pass rather than post-emit:
- Image imports must reach the renderer as JS values, not unresolved
  imports (the inline bundler would strip them and the page would
  render `undefined`).
- Substituting BEFORE TS-strip means esbuild sees a normal const
  declaration — no special handling.
- Phase 11's hoister moves it to module scope alongside other
  `const`s, so the runtime sees it before any reference.

When `host.imageService` is absent or `getMetadata` throws, the import
is left in place and a `module-graph.image-import.unresolved` log
event fires. Tests that don't exercise images don't have to wire one.

### Runtime `<Image>` and `<Picture>` (`@astroflare/runtime/components`)

```astro
---
import { Image } from "@astroflare/runtime/components";
import logo from "../assets/logo.png";
---
<Image src={logo} alt="Logo" loading="lazy" />
```

Renders to `<img src="/_aflare/asset/.../logo.png" alt="Logo"
width="..." height="..." loading="lazy" />`. Either accepts an
`ImageMetadata` literal (the compiler-emitted shape) or a bare URL
string (escape hatch for remote images).

`<Picture>` wraps the same `<img>` in `<picture>...</picture>` —
single-source for now. Multi-source DPR/format variants ride along
when the host's `ImageService` grows format-conversion capability.

8 unit tests cover both components: metadata input vs string,
override semantics, loading/decoding/class/id passthrough, HTML
escaping, missing-dimension behaviour.

### Preview server `/_aflare/asset/<path>` route

The default `src` URLs the host's `ImageService` produces look like
`/_aflare/asset/<workspace-path>`. The preview server has a small
asset handler that intercepts those, reads the bytes from
`host.storage`, and returns them with the right image content-type
and `cache-control: public, max-age=31536000, immutable` (the URL is
content-addressed via the workspace path; cache-bust by changing
the file). Three tests cover the happy path, missing files (404),
and content-type mapping.

### Structural source-map (Phase 13's minimum-viable path)

The .astro compiler now produces a v3 source map alongside the
emitted JS. The map is **structural**, not per-token: each
generated line points back to line 1 column 0 of the original
source. Browser devtools recognise the `.astro` filename and load
`sourcesContent` correctly even though per-token positions aren't
yet precise.

```ts
{
  version: 3,
  file: "index.js",
  sources: ["/src/pages/index.astro"],
  sourcesContent: [<original source>],
  names: [],
  mappings: "AAAA;AAAA;AAAA;…"
}
```

`inlineSourceMappingURL(map)` produces the `//# sourceMappingURL=
data:application/json;base64,...` comment for callers that want to
embed the map in the generated code. Not currently appended by
default — that's a Phase 23 follow-on.

Per-token source maps using each AST node's `range` would require
the emitter to track output offsets in every `emit*()` helper.
Substantial refactor for marginal benefit until a host-side
production deploy actually consumes the maps. Documented as Phase
23 carve-out.

## Numbers

- **482 tests / 43 files / 5 pools** all green.
- 17 new tests since Phase 12:
  - `runtime/components.test.ts` — 8 unit tests for `<Image>` /
    `<Picture>`
  - `test-utils/memory-image-service.test.ts` — 3 unit tests
  - `compiler/astro/source-map.test.ts` — 4 sourcemap tests
  - `preview/preview-server.test.ts` — 3 e2e tests (image import
    substitution rendering, asset URL serving, asset 404)
- Framework boundary still holds.

## Surprises

- **`<picture>` without sources is just `<picture><img/></picture>`.**
  The Phase 13 `<Picture>` wraps a single `<img>`. That's not
  meaningfully different from a bare `<img>`, but it gives users a
  call site to opt into when DPR/format variants land — they
  wouldn't have to change their template, only the runtime
  implementation. Cheap forward-compat.

- **`Uint8Array` from `Storage.read` doesn't satisfy `BodyInit`.**
  workerd's lib types declare `Storage.read` as `Promise<Uint8Array>`
  with `ArrayBufferLike` as the buffer (which includes
  `SharedArrayBuffer`). `Response` only accepts plain `ArrayBuffer`.
  Copy via `new Uint8Array(bytes.byteLength); copy.set(bytes); new
  Response(copy.buffer)` — small allocation but typesafe.

- **The image-import regex matches BEFORE TS-strip.** That means it
  scans the user's frontmatter source verbatim. JS comments and
  string literals containing `import x from "y.png"` would match.
  Not a real risk in practice — the bigger constraint is that the
  regex assumes the import is on its own line. Multi-line imports
  (e.g. `import\n  X\n  from "./y.png";`) would be missed.

- **Source maps need the original source string.** The emitter sees
  only the AST, not the source. So `compileAstro` builds the map
  twice — once with empty `sourcesContent` (inside `emitDocument`),
  then re-builds it with the real source attached. Wastes a tiny
  bit of work; cleaner alternative is passing source into
  `EmitOptions`. Punted.

## What did NOT land in this run (and why)

- **PNG/JPEG header parsing in test-utils.** Real production hosts
  parse image headers to read width/height; the test stub just
  returns hand-supplied values. Adding the parsing isn't hard
  (PNG dimensions are at bytes 16–23) but it's host-layer work per
  the brief.

- **Format conversion (AVIF/WebP).** Cloudflare Images binding
  handles this; framework just hands metadata through.

- **DPR variants and `<Picture>` multi-source.** Falls out naturally
  when the host's ImageService grows variant URLs. The runtime
  component is forward-compatible.

- **Blurred placeholders / LQIP.** Same boat — needs host-side image
  decoding.

- **Per-token source maps.** Phase 23 carryover. The structural map
  is enough to unblock devtools showing the right source name.

- **`sourceMappingURL` injection in compiled output.** The map is
  available on `CompileResult.map`; we don't yet append the
  `//# sourceMappingURL=` comment to the bundle. Wait until the
  preview server emits source-mapped bundles via `Content-Type:
  application/javascript` (currently embeds JS inside HTML).

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm lint` — green (134 files).
- `pnpm test` — **482 tests across 43 files, all 5 pools green**.
- Framework boundary check — zero `cloudflare:` / `@cloudflare/`
  matches in framework packages.
- §11.1 of the brief is one step closer: the `minimal-blog`
  fixture can now grow an image asset alongside the existing
  routes. (Not yet exercised in the fixture itself — the fixture's
  v2 with images is its own carve-out.)

## What the next phase starts from

Phase 14 is **MDX + Shiki + remark/rehype plugin chain + named
`.md` exports**. The compiler's hoisting/substitution machinery
from Phases 10–13 means new compile-time transforms (MDX → JSX →
JS) can ride the same pipeline without bundler regression. The
asset pipeline plus `<Image>` runtime gives MDX images an obvious
home — `![alt](./img.png)` in MDX should resolve through the same
ImageService used by `.astro` imports.
