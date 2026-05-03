/**
 * `af logs <name> [--tail]` — Worker logs via Cloudflare's tail API.
 * Phase 26c.
 *
 * Implementation note: Cloudflare's official path is
 * `wrangler tail <worker>`. We shell out to it because the JSON
 * stream protocol over websockets is non-trivial to reimplement and
 * keeping in step with Cloudflare's auth/tail evolutions is brittle.
 *
 * Returns spawn metadata + the wrangler command the caller would
 * exec; the actual streaming is done by spawning the child process.
 * Tests assert the command shape; live usage launches wrangler.
 */

export interface LogsInput {
	workerName: string;
	tail?: boolean;
	since?: string;
}

export interface LogsResult {
	command: readonly string[];
	notes: readonly string[];
}

export function logsCommand(input: LogsInput): LogsResult {
	const args = ["tail", input.workerName, "--format=json"];
	if (input.since) args.push(`--since=${input.since}`);
	const command = ["wrangler", ...args] as const;
	const notes: string[] = [];
	if (!input.tail) {
		notes.push(
			"`wrangler tail` is inherently streaming; pass --tail to make this explicit. This call returns the command shape; the CLI spawns wrangler in tail mode.",
		);
	}
	return { command, notes };
}
