/**
 * `@astroflare/site-workspace` — `Site` adapter for Cloudflare's
 * `@cloudflare/shell` `Workspace` (Phase 26).
 *
 * Lives as a separate package so the framework's
 * `@astroflare/host-cloudflare` doesn't take a dep on
 * `@cloudflare/shell`. Hosts that use Workspace import this package;
 * hosts using a different filesystem implement `Site` themselves.
 */
export * from "./workspace-site.js";
