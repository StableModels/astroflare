#!/usr/bin/env node
/**
 * `aflare-e2e` CLI dispatch.
 *
 * Parses argv, resolves config, builds a CloudflareClient against
 * the live API (using `process.env.CLOUDFLARE_ACCOUNT_ID` +
 * `CLOUDFLARE_API_TOKEN`), and dispatches to the per-command
 * implementation.
 *
 * Today's verb set:
 *   provision <fixture>       — create resources
 *   teardown  <fixture>       — destroy resources
 *   teardown-all              — destroy every fixture for the current SHA
 *   list                      — list provisioned fixtures
 *
 * Deferred to Phase 20a: `build`/`deploy`/`run`/`preview` (these
 * shell out to the existing `aflare` CLI plus `wrangler` /
 * `vitest run --project e2e`); `inspect`/`status`; observe-tier
 * commands (`logs`/`metrics`/`trace`); `gc`. The architectural
 * split is ready — see `commands/` for the verb registry.
 *
 * The `Cli` class accepts a custom dispatcher so unit tests can drive
 * the command surface without touching the live API. Production runs
 * the binary, which builds a real `CloudflareClient` and dispatches
 * via the same path.
 */

import { execSync } from "node:child_process";
import { type CloudflareClient, makeCloudflareClient } from "./api.js";
import { findOrphanWorkers } from "./commands/gc.js";
import { inspectFixture } from "./commands/inspect.js";
import { listFixtures } from "./commands/list.js";
import { provisionFixture } from "./commands/provision.js";
import { statusReport } from "./commands/status.js";
import { teardownFixture } from "./commands/teardown.js";
import type { FixtureState } from "./state.js";

export interface CliEnv {
	rootDir: string;
	sha7: string;
	cloudflareAccountId: string;
	cloudflareApiToken: string;
}

export interface CliOptions {
	env: CliEnv;
	client?: CloudflareClient;
	/** Read from disk; tests use an in-memory bundle. */
	loadBundle?: (fixture: string) => Promise<string>;
	/** Output sink — `console.log` in production, captured in tests. */
	log?: (line: string) => void;
}

export class Cli {
	#opts: CliOptions;
	#client: CloudflareClient;

	constructor(opts: CliOptions) {
		this.#opts = opts;
		this.#client =
			opts.client ??
			makeCloudflareClient({
				accountId: opts.env.cloudflareAccountId,
				apiToken: opts.env.cloudflareApiToken,
			});
	}

	async run(argv: readonly string[]): Promise<number> {
		const [verb, ...rest] = argv;
		switch (verb) {
			case "provision":
				return await this.#provision(rest);
			case "teardown":
				return await this.#teardown(rest);
			case "teardown-all":
				return await this.#teardownAll();
			case "list":
				return this.#list();
			case "inspect":
				return this.#inspect(rest);
			case "status":
				return await this.#status();
			case "gc":
				return await this.#gc();
			case undefined:
			case "--help":
			case "-h":
				this.#log(USAGE);
				return 0;
			default:
				this.#log(`unknown command: ${verb}\n${USAGE}`);
				return 1;
		}
	}

	async #provision(args: readonly string[]): Promise<number> {
		const [fixture] = args;
		if (!fixture) {
			this.#log("usage: aflare-e2e provision <fixture>");
			return 1;
		}
		const loader = this.#opts.loadBundle ?? defaultLoadBundle;
		const bundle = await loader(fixture);
		const state = await provisionFixture({
			rootDir: this.#opts.env.rootDir,
			sha7: this.#opts.env.sha7,
			fixture,
			client: this.#client,
			workerBundle: bundle,
		});
		this.#log(`provisioned ${state.workerName} → ${state.url}`);
		return 0;
	}

	async #teardown(args: readonly string[]): Promise<number> {
		const [fixture] = args;
		if (!fixture) {
			this.#log("usage: aflare-e2e teardown <fixture>");
			return 1;
		}
		const result = await teardownFixture({
			rootDir: this.#opts.env.rootDir,
			sha7: this.#opts.env.sha7,
			fixture,
			client: this.#client,
		});
		if (result.deletedWorker) {
			this.#log(`destroyed ${result.deletedWorker} + ${result.deletedBucket}`);
		} else {
			this.#log(`no state for ${fixture} (already torn down or never provisioned)`);
		}
		return 0;
	}

	async #teardownAll(): Promise<number> {
		const fixtures = listFixtures({
			rootDir: this.#opts.env.rootDir,
			sha7: this.#opts.env.sha7,
		});
		if (fixtures.length === 0) {
			this.#log("no fixtures to tear down");
			return 0;
		}
		let exitCode = 0;
		for (const f of fixtures) {
			try {
				await teardownFixture({
					rootDir: this.#opts.env.rootDir,
					sha7: this.#opts.env.sha7,
					fixture: f.fixture,
					client: this.#client,
				});
				this.#log(`destroyed ${f.workerName}`);
			} catch (err) {
				this.#log(`teardown failed for ${f.fixture}: ${(err as Error).message}`);
				exitCode = 1;
			}
		}
		return exitCode;
	}

	#list(): number {
		const fixtures = listFixtures({
			rootDir: this.#opts.env.rootDir,
			sha7: this.#opts.env.sha7,
		});
		if (fixtures.length === 0) {
			this.#log("no fixtures provisioned for this SHA");
			return 0;
		}
		for (const f of fixtures) {
			this.#log(`${f.fixture}\t${f.workerName}\t${f.url}`);
		}
		return 0;
	}

	#inspect(args: readonly string[]): number {
		const [fixture] = args;
		if (!fixture) {
			this.#log("usage: aflare-e2e inspect <fixture>");
			return 1;
		}
		const state = inspectFixture({
			rootDir: this.#opts.env.rootDir,
			sha7: this.#opts.env.sha7,
			fixture,
		});
		if (!state) {
			this.#log(`no state for ${fixture} (run \`aflare-e2e provision ${fixture}\` first)`);
			return 1;
		}
		this.#log(JSON.stringify(state, null, 2));
		return 0;
	}

	async #status(): Promise<number> {
		const report = await statusReport({
			rootDir: this.#opts.env.rootDir,
			sha7: this.#opts.env.sha7,
		});
		if (report.length === 0) {
			this.#log("no fixtures provisioned for this SHA");
			return 0;
		}
		let exitCode = 0;
		for (const r of report) {
			if (r.error) {
				this.#log(`${r.fixture}\t-\t${r.error}`);
				exitCode = 1;
			} else if (r.httpStatus !== 200) {
				this.#log(`${r.fixture}\t${r.httpStatus}\t${r.latencyMs}ms`);
				exitCode = 1;
			} else {
				this.#log(`${r.fixture}\t${r.httpStatus}\t${r.latencyMs}ms`);
			}
		}
		return exitCode;
	}

	async #gc(): Promise<number> {
		const result = await findOrphanWorkers({
			rootDir: this.#opts.env.rootDir,
			client: this.#client,
		});
		if (result.orphans.length === 0) {
			this.#log("no orphan workers");
			return 0;
		}
		this.#log(`${result.orphans.length} orphan worker(s):`);
		for (const o of result.orphans) {
			this.#log(`  ${o.id}${o.created_on ? `\t${o.created_on}` : ""}`);
		}
		this.#log("(re-run with `--purge` to delete; not yet implemented)");
		return 0;
	}

	#log(line: string): void {
		(this.#opts.log ?? console.log)(line);
	}
}

const USAGE = `aflare-e2e — Phase 20 end-to-end test orchestrator

Usage:
  aflare-e2e <command> [args]

Commands:
  provision <fixture>      Create Worker + R2 bucket for a fixture
  teardown  <fixture>      Destroy resources, remove state
  teardown-all             Destroy every fixture for the current SHA
  list                     List provisioned fixtures
  inspect   <fixture>      Print the state file for a fixture
  status                   HEAD / each provisioned URL; report status + latency
  gc                       List orphan workers in the account not in local state

Environment:
  CLOUDFLARE_ACCOUNT_ID    The Cloudflare account hosting the test resources
  CLOUDFLARE_API_TOKEN     Workers Scripts edit + R2 edit + DO edit scopes
  AFLARE_E2E_SHA           Override the SHA used in resource names (default: git rev-parse --short HEAD)
  AFLARE_E2E_ROOT          Override the repo root (default: cwd)
`;

async function defaultLoadBundle(fixture: string): Promise<string> {
	// In production this would shell out to the existing aflare CLI to
	// build the fixture into a Worker bundle. For Phase 20 we ship the
	// scaffolding; the bundle path is wired alongside the fixture work.
	return `// stub bundle for fixture: ${fixture}\nexport default { fetch() { return new Response("ok"); } };`;
}

/** Production entry point. */
export async function main(argv: readonly string[]): Promise<number> {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	if (!accountId) {
		console.error("CLOUDFLARE_ACCOUNT_ID is required");
		return 2;
	}
	if (!apiToken) {
		console.error("CLOUDFLARE_API_TOKEN is required");
		return 2;
	}
	const sha7 =
		process.env.AFLARE_E2E_SHA ?? execSync("git rev-parse --short=7 HEAD").toString().trim();
	const rootDir = process.env.AFLARE_E2E_ROOT ?? process.cwd();
	const cli = new Cli({
		env: { rootDir, sha7, cloudflareAccountId: accountId, cloudflareApiToken: apiToken },
	});
	return await cli.run(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	void main(process.argv.slice(2)).then((code) => {
		process.exit(code);
	});
}

// Re-export for callers that want to drive specific bits programmatically.
export type { FixtureState };
