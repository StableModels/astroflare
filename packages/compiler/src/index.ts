/**
 * @astroflare/compiler — pure-JS compilers for `.astro`, `.md`, `.mdx`, JSX, SFCs.
 *
 * Phase 2 filled `astro/`. Phase 6 fills `markdown/` (`.md` → ESM, with
 * frontmatter + remark/rehype). Phase 8 fills `jsx/` and `sfc/`.
 *
 * No Cloudflare imports; no native bindings; no Vite. Compilers run inside
 * Compile DWs at preview time and inside the Workflow at deploy time.
 */
export * from "./astro/index.js";
export * from "./markdown/index.js";
export * from "./mdx/index.js";
export type { ShikiEngine } from "./shiki/index.js";

export const COMPILER_VERSION = "0.0.0";
