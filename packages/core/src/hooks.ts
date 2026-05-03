/**
 * Integration hook surface (Astro-shaped).
 *
 * Astro defines hooks like `astro:config:setup`, `astro:build:start`, etc. We
 * mirror that vocabulary so existing Astro integrations can be ported with
 * minimal changes once the surface is filled out.
 *
 * Phase 8+ implements this. For Phase 1a we declare the named hooks as a
 * type so downstream packages can begin to reference them without crashing
 * the type-checker. The shape is intentionally narrower than Astro's — we
 * only add hooks once a feature actually needs one (§3 Tier 3 deferral).
 */

export type HookName =
	| "astroflare:config:setup"
	| "astroflare:config:done"
	| "astroflare:server:setup"
	| "astroflare:server:start"
	| "astroflare:server:done"
	| "astroflare:build:start"
	| "astroflare:build:setup"
	| "astroflare:build:generated"
	| "astroflare:build:ssr"
	| "astroflare:build:done";

export interface Integration {
	name: string;
	hooks: Partial<Record<HookName, (...args: unknown[]) => unknown>>;
}
