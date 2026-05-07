/**
 * @astroflare/build/node — Node-only build pipeline (Phase 26b).
 *
 * Used by the CLI's `deployStaticBundle` and by host applications
 * doing local-FS builds. Imports `node:crypto` / `node:fs` /
 * `node:os` — never imported from worker-runtime code.
 */

export { LocalSite, type LocalSiteOptions } from "./local-site.js";
export {
	buildSite,
	deploySite,
	type BuildSiteOptions,
	type DeploySiteOptions,
	type DeploySiteResult,
} from "./build-site.js";

export type { BuildSiteOutput, SnapshotError } from "@astroflare/core";
