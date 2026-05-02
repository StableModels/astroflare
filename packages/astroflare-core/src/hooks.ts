import type { AstroflareConfig, AstroflareIntegration } from "./types.js";

/**
 * Run integration hooks for a given lifecycle event.
 *
 * Tier 0 surface: integrations may observe but not yet mutate the config.
 * Full Astro `astro:*` hook parity lives in Tier 3.
 */
export async function runHook<K extends "config:setup" | "build:start" | "build:done">(
  integrations: AstroflareIntegration[] | undefined,
  hook: K,
  ctx: { config: AstroflareConfig },
): Promise<void> {
  if (!integrations) return;
  for (const integration of integrations) {
    const fn = integration.hooks?.[hook];
    if (fn) await fn(ctx);
  }
}
