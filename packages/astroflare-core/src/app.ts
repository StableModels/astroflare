import { runHook } from "./hooks.js";
import type { AstroflareConfig, Host } from "./types.js";

export interface AstroflareApp {
  readonly config: AstroflareConfig;
  readonly host: Host;
  /** Resolve and serve a request using the live preview pipeline. Implemented in Phase 3. */
  fetch(req: Request): Promise<Response>;
}

export interface CreateAppOptions {
  config: AstroflareConfig;
  host: Host;
}

/**
 * Compose a framework instance from a config and a host.
 *
 * The framework is a function: (Storage, Executor, Coordinator, Transport, Clock, Logger)
 * -> AstroflareApp. Cloudflare-specific wiring lives outside this package.
 */
export async function createApp(opts: CreateAppOptions): Promise<AstroflareApp> {
  const { config, host } = opts;
  await runHook(config.integrations, "config:setup", { config });

  return {
    config,
    host,
    async fetch(_req: Request): Promise<Response> {
      // Phase 3 wires the preview pipeline here. Until then, we return 501 so the
      // boundary is observable end-to-end without pretending to render.
      return new Response("Astroflare preview not yet implemented", { status: 501 });
    },
  };
}
