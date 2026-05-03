/**
 * `acceptHmrSocket` — top-level helper for HMR WebSocket upgrade
 * (Phase 26). Equivalent to `coordinator.acceptHmrSocket(req)` but
 * with an explicit `ctx` parameter, matching the Phase 26 plan's
 * documented host-integration shape:
 *
 *   if (url.pathname === "/_aflare/hmr") {
 *     return acceptHmrSocket(this.ctx, req, this.#coordinator);
 *   }
 *
 * `ctx` is documented separately so the coordinator factory doesn't
 * have to be reconstructed per-request, while the WS lifecycle still
 * routes through whatever DO state the host wants to use. In
 * practice, `ctx` and the coordinator's internal `ctx` will be the
 * same object — this helper is sugar over `coordinator.acceptHmrSocket`.
 */

import type { AstroflareCoordinator, CoordinatorContext } from "./coordinator.js";

export function acceptHmrSocket(
	_ctx: CoordinatorContext,
	req: Request,
	coordinator: AstroflareCoordinator,
): Response {
	return coordinator.acceptHmrSocket(req);
}
