/**
 * @astroflare/compiler — pure-JS compilers for `.astro`, `.md`, `.mdx`, JSX, SFCs.
 *
 * Phase 2 fills `astro/` (TypeScript parser + emitter for `.astro`, output ABI
 * matching Astro's render-function default export).
 *
 * Phase 6 fills `mdx/`. Phase 8 fills `jsx/` and `sfc/`.
 *
 * No Cloudflare imports; no native bindings; no Vite. Compilers run inside
 * Compile DWs at preview time and inside the Workflow at deploy time.
 */
export * from "./astro/index.js";

export const COMPILER_VERSION = "0.0.0";
