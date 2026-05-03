/**
 * Structured CLI errors with stable codes.
 *
 * Phase 26c: the CLI's primary user is the agent driving development
 * + debugging. Errors carry a stable `code` so the agent can branch
 * programmatically without parsing message strings; `context` carries
 * structured fields the agent can use to resolve the failure.
 *
 * Adding new codes is non-breaking. Renaming or repurposing codes
 * is breaking — bump the CLI version major when changing semantics.
 */

export const CLI_ERROR_CODES = {
	/** Required Cloudflare credential env var is missing. */
	MISSING_CREDENTIAL: "MISSING_CREDENTIAL",
	/** Cloudflare API token rejected (401 from REST). */
	AUTH_FAILED: "AUTH_FAILED",
	/** API token doesn't have a required scope. */
	TOKEN_SCOPE_MISSING: "TOKEN_SCOPE_MISSING",
	/** Worker Loader binding requires a paid Cloudflare plan. */
	WORKER_LOADER_PLAN_REQUIRED: "WORKER_LOADER_PLAN_REQUIRED",
	/** Account-level subdomain isn't configured (`*.workers.dev`). */
	WORKERS_SUBDOMAIN_MISSING: "WORKERS_SUBDOMAIN_MISSING",
	/** No state file for the requested host name + SHA. */
	HOST_NOT_FOUND: "HOST_NOT_FOUND",
	/** State file exists but is malformed. */
	HOST_STATE_INVALID: "HOST_STATE_INVALID",
	/** A stack name was given but no stack state exists. */
	STACK_NOT_FOUND: "STACK_NOT_FOUND",
	/** Required CLI argument missing. */
	ARG_MISSING: "ARG_MISSING",
	/** CLI argument value rejected (wrong type, out of range, etc.). */
	ARG_INVALID: "ARG_INVALID",
	/** The R2 bucket the command needs is missing. */
	R2_BUCKET_MISSING: "R2_BUCKET_MISSING",
	/** R2 object the command tried to read isn't there. */
	R2_OBJECT_MISSING: "R2_OBJECT_MISSING",
	/** No `current` pointer in the stack — never deployed. */
	NO_CURRENT_DEPLOY: "NO_CURRENT_DEPLOY",
	/** A deploy hash referenced in `current` has no objects under it. */
	DEPLOY_NOT_FOUND: "DEPLOY_NOT_FOUND",
	/** Catch-all for unexpected REST API failures. */
	CLOUDFLARE_API_ERROR: "CLOUDFLARE_API_ERROR",
	/** The CLI is running in an environment that doesn't satisfy a precondition. */
	PRECONDITION_FAILED: "PRECONDITION_FAILED",
} as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES];

/**
 * Throw from `cli-lib` library functions when an operation can't
 * proceed. Always carries a stable `code` and a structured `context`
 * the calling agent (or human) can use to resolve.
 */
export class AstroflareCliError extends Error {
	readonly code: CliErrorCode;
	readonly context: Record<string, unknown>;

	constructor(code: CliErrorCode, message: string, context: Record<string, unknown> = {}) {
		super(message);
		this.name = "AstroflareCliError";
		this.code = code;
		this.context = context;
	}

	/** JSON shape stable across versions: `{ error: { code, message, context } }`. */
	toJSON(): { error: { code: string; message: string; context: Record<string, unknown> } } {
		return {
			error: {
				code: this.code,
				message: this.message,
				context: this.context,
			},
		};
	}
}

/** Type guard for catch-clauses. */
export function isAstroflareCliError(err: unknown): err is AstroflareCliError {
	return err instanceof AstroflareCliError;
}
