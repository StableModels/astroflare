/**
 * `createApp(config, host) → AstroflareApp`.
 *
 * Phase 1a: the bare skeleton. `handlePreviewRequest` stubs out 501 until
 * Phase 3 wires the preview server. `handleHmrUpgrade` delegates to
 * `host.transport`. `notifyFileChanged` delegates to `host.coordinator`.
 *
 * The brief's framework-as-function shape (§5.2) is the entry point —
 * everything downstream consumes only the `host` and `config` passed here,
 * never reaches into Cloudflare APIs.
 */
import type { AstroflareApp, AstroflareConfig, Host } from "./types.js";

export function createApp(config: AstroflareConfig, host: Host): AstroflareApp {
	host.logger.event("app.created", {
		site: config.site ?? null,
		output: config.output ?? "static",
	});

	return {
		async handlePreviewRequest(_req: Request): Promise<Response> {
			// Phase 3 wires real preview handling.
			return new Response("astroflare preview: Phase 1a placeholder", {
				status: 501,
				headers: { "content-type": "text/plain" },
			});
		},

		async handleHmrUpgrade(req: Request): Promise<Response> {
			// Workspace identity is derived by the host before reaching this layer;
			// for Phase 1a we use a placeholder. Phase 3+ wires per-tenant routing.
			return host.transport.acceptHmrSocket(req, { workspaceId: "default" });
		},

		async notifyFileChanged(path: string, hash: string): Promise<void> {
			await host.coordinator.onFileChanged(path, hash);
		},

		async notifyFileRemoved(path: string): Promise<void> {
			await host.coordinator.onFileRemoved(path);
		},
	};
}
