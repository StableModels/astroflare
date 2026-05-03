/**
 * `@astroflare/cli` — programmatic surface.
 *
 * The `aflare` binary (see `cli.ts`) is the user-facing entrypoint;
 * this module exports the underlying functions so other tools (a
 * GitHub Action, a custom deploy script, an editor integration) can
 * call them directly without shell-quoting argv.
 */

export {
	type DeployConfig,
	type DeployResult,
	resolveConfig,
	walkProjectFiles,
	uploadFiles,
	triggerDeploy,
	getStatus,
} from "./commands/deploy.js";

export const CLI_VERSION = "0.0.0";
