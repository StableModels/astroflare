#!/usr/bin/env node
/**
 * `af` — Astroflare CLI entrypoint.
 *
 * Single, flat command surface for everything you need to deploy,
 * operate, introspect, test, and diagnose an Astroflare project on
 * Cloudflare. The verbs split into two groups:
 *
 *   PROJECT (lifecycle of a deployed Astroflare site):
 *     init <dir>       Scaffold a new Astroflare project
 *     deploy [dir]     Upload project files to R2 and run the deploy
 *                      ceremony on the project worker
 *     status           Show the active deploy hash
 *     rollback <hash>  Flip /site/current to a previous deploy
 *
 *   CLOUDFLARE OPERATIONS (account-wide / per-Worker):
 *     list             Enumerate Workers managed by `af`
 *     inspect <name>   Print state for a managed Worker
 *     health           HEAD each managed URL; report status + latency
 *     destroy <name>   Destroy a Worker and clean up its R2 bucket
 *     destroy-all      Destroy every Worker for the current SHA
 *     gc               Find orphan Workers in the account
 *
 * The `destroy*`/`provision`/`inspect` verbs operate on the same
 * `tests/e2e/.state/<sha7>/<name>.json` registry the e2e test suite
 * uses for its setup/teardown — the CLI is a thin facade over the
 * shared library so manual ops and automated tests share state and
 * behaviour. (The e2e tests themselves don't need the CLI; they run
 * via `vitest run --project e2e` and orchestrate their own
 * provisioning through globalSetup.)
 *
 * Configuration resolves in priority order: CLI flags →
 * environment (CLOUDFLARE_*, AFLARE_E2E_*, DEPLOY_TOKEN) →
 * `aflare.config.json`.
 *
 * Output: stdout is one-line JSON (scriptable); stderr is human
 * progress.
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
	type CloudflareClient,
	findOrphanWorkers,
	inspectFixture,
	listFixtures,
	makeCloudflareClient,
	provisionFixture,
	statusReport,
	teardownFixture,
} from "@astroflare/e2e";
import { type DeployConfig, resolveConfig } from "./commands/deploy.js";
import { cmdDeploy, cmdRollback, cmdStatus } from "./commands/deploy.js";
import { loadFixtureBundle } from "./commands/fixtures.js";
import { initProject } from "./commands/init.js";

async function main(argv: readonly string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === "--help" || subcommand === "-h") {
		printUsage();
		return 0;
	}

	switch (subcommand) {
		// Project lifecycle.
		case "init":
			return runInit(rest);
		case "deploy":
			return runDeploy(rest);
		case "status":
			return runStatus(rest);
		case "rollback":
			return runRollback(rest);

		// Cloudflare account / Worker ops. Shared library functions —
		// the e2e test suite's globalSetup uses the same ones, so manual
		// CLI work and automated tests stay in sync.
		case "provision":
			return runProvision(rest);
		case "destroy":
			return runDestroy(rest);
		case "destroy-all":
			return runDestroyAll();
		case "list":
			return runList();
		case "inspect":
			return runInspect(rest);
		case "health":
			return runHealth();
		case "gc":
			return runGc();

		case "--version":
		case "-v":
			console.log("af 0.0.0");
			return 0;
		default:
			console.error(`af: unknown subcommand '${subcommand}'\n`);
			printUsage();
			return 1;
	}
}

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

async function runInit(argv: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...argv],
		options: {
			force: { type: "boolean" },
			name: { type: "string" },
			site: { type: "string" },
		},
		allowPositionals: true,
	});
	const dir = positionals[0];
	if (!dir) {
		console.error("af init: missing <dir> argument");
		return 1;
	}
	try {
		const result = initProject({
			dir,
			force: Boolean(values.force),
			name: values.name as string | undefined,
			site: values.site as string | undefined,
		});
		console.log(`Created ${result.created.length} files in ${dir}`);
		if (result.skipped.length > 0) {
			console.log(`Skipped (use --force to overwrite): ${result.skipped.join(", ")}`);
		}
		return 0;
	} catch (err) {
		console.error(`af init: ${(err as Error).message}`);
		return 1;
	}
}

async function runDeploy(argv: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...argv],
		options: sharedOptions(),
		allowPositionals: true,
	});
	const cfg = await loadConfig(values, positionals[0] ?? ".");
	const result = await cmdDeploy(cfg, console.error);
	console.log(JSON.stringify(result));
	return 0;
}

async function runStatus(argv: readonly string[]): Promise<number> {
	const { values } = parseArgs({
		args: [...argv],
		options: sharedOptions(),
		allowPositionals: true,
	});
	const cfg = await loadConfig(values, ".");
	const result = await cmdStatus(cfg);
	console.log(JSON.stringify(result));
	return 0;
}

async function runRollback(argv: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...argv],
		options: sharedOptions(),
		allowPositionals: true,
	});
	const hash = positionals[0];
	if (!hash) {
		console.error("af rollback: missing <hash> argument");
		return 1;
	}
	const cfg = await loadConfig(values, ".");
	const result = await cmdRollback(cfg, hash);
	console.log(JSON.stringify(result));
	return 0;
}

// ---------------------------------------------------------------------------
// Cloudflare account / Worker ops
// ---------------------------------------------------------------------------

interface OpsCtx {
	rootDir: string;
	sha7: string;
	client: CloudflareClient;
}

function opsCtx(): OpsCtx {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
	if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required");
	const sha7 =
		process.env.AFLARE_E2E_SHA ?? execSync("git rev-parse --short=7 HEAD").toString().trim();
	const rootDir = process.env.AFLARE_E2E_ROOT ?? process.cwd();
	const client = makeCloudflareClient({ accountId, apiToken });
	return { rootDir, sha7, client };
}

async function runProvision(argv: readonly string[]): Promise<number> {
	const [name] = argv;
	if (!name) {
		console.error("af provision: missing <name> argument");
		return 1;
	}
	try {
		const ctx = opsCtx();
		const bundle = await loadFixtureBundle(name, ctx.rootDir);
		const state = await provisionFixture({
			rootDir: ctx.rootDir,
			sha7: ctx.sha7,
			fixture: name,
			client: ctx.client,
			workerBundle: bundle,
		});
		console.log(`provisioned ${state.workerName} → ${state.url}`);
		return 0;
	} catch (err) {
		console.error(`af provision: ${(err as Error).message}`);
		return 1;
	}
}

async function runDestroy(argv: readonly string[]): Promise<number> {
	const [name] = argv;
	if (!name) {
		console.error("af destroy: missing <name> argument");
		return 1;
	}
	try {
		const ctx = opsCtx();
		const r = await teardownFixture({
			rootDir: ctx.rootDir,
			sha7: ctx.sha7,
			fixture: name,
			client: ctx.client,
		});
		if (r.deletedWorker) {
			console.log(`destroyed ${r.deletedWorker}${r.deletedBucket ? ` + ${r.deletedBucket}` : ""}`);
		} else {
			console.log(`no state for ${name} (already torn down or never provisioned)`);
		}
		return 0;
	} catch (err) {
		console.error(`af destroy: ${(err as Error).message}`);
		return 1;
	}
}

async function runDestroyAll(): Promise<number> {
	try {
		const ctx = opsCtx();
		const fixtures = listFixtures({ rootDir: ctx.rootDir, sha7: ctx.sha7 });
		if (fixtures.length === 0) {
			console.log("no Workers to destroy");
			return 0;
		}
		let exitCode = 0;
		for (const f of fixtures) {
			try {
				await teardownFixture({
					rootDir: ctx.rootDir,
					sha7: ctx.sha7,
					fixture: f.fixture,
					client: ctx.client,
				});
				console.log(`destroyed ${f.workerName}`);
			} catch (err) {
				console.error(`destroy ${f.fixture}: ${(err as Error).message}`);
				exitCode = 1;
			}
		}
		return exitCode;
	} catch (err) {
		console.error(`af destroy-all: ${(err as Error).message}`);
		return 1;
	}
}

function runList(): number {
	try {
		const ctx = opsCtx();
		const fixtures = listFixtures({ rootDir: ctx.rootDir, sha7: ctx.sha7 });
		if (fixtures.length === 0) {
			console.log("no Workers managed for this SHA");
			return 0;
		}
		for (const f of fixtures) {
			console.log(`${f.fixture}\t${f.workerName}\t${f.url}`);
		}
		return 0;
	} catch (err) {
		console.error(`af list: ${(err as Error).message}`);
		return 1;
	}
}

function runInspect(argv: readonly string[]): number {
	const [name] = argv;
	if (!name) {
		console.error("af inspect: missing <name> argument");
		return 1;
	}
	try {
		const ctx = opsCtx();
		const state = inspectFixture({ rootDir: ctx.rootDir, sha7: ctx.sha7, fixture: name });
		if (!state) {
			console.error(`no state for ${name} (run \`af provision ${name}\` first)`);
			return 1;
		}
		console.log(JSON.stringify(state, null, 2));
		return 0;
	} catch (err) {
		console.error(`af inspect: ${(err as Error).message}`);
		return 1;
	}
}

async function runHealth(): Promise<number> {
	try {
		const ctx = opsCtx();
		const report = await statusReport({ rootDir: ctx.rootDir, sha7: ctx.sha7 });
		if (report.length === 0) {
			console.log("no Workers managed for this SHA");
			return 0;
		}
		let exitCode = 0;
		for (const r of report) {
			if (r.error) {
				console.log(`${r.fixture}\t-\t${r.error}`);
				exitCode = 1;
			} else if (r.httpStatus !== 200) {
				console.log(`${r.fixture}\t${r.httpStatus}\t${r.latencyMs}ms`);
				exitCode = 1;
			} else {
				console.log(`${r.fixture}\t${r.httpStatus}\t${r.latencyMs}ms`);
			}
		}
		return exitCode;
	} catch (err) {
		console.error(`af health: ${(err as Error).message}`);
		return 1;
	}
}

async function runGc(): Promise<number> {
	try {
		const ctx = opsCtx();
		const result = await findOrphanWorkers({ rootDir: ctx.rootDir, client: ctx.client });
		if (result.orphans.length === 0) {
			console.log("no orphan workers");
			return 0;
		}
		console.log(`${result.orphans.length} orphan worker(s):`);
		for (const o of result.orphans) {
			console.log(`  ${o.id}${o.created_on ? `\t${o.created_on}` : ""}`);
		}
		return 0;
	} catch (err) {
		console.error(`af gc: ${(err as Error).message}`);
		return 1;
	}
}

// ---------------------------------------------------------------------------
// Shared option parsing
// ---------------------------------------------------------------------------

function sharedOptions() {
	return {
		"account-id": { type: "string" as const },
		bucket: { type: "string" as const },
		"api-token": { type: "string" as const },
		url: { type: "string" as const },
		"deploy-token": { type: "string" as const },
		"project-dir": { type: "string" as const },
	};
}

interface ParsedFlags {
	"account-id"?: string;
	bucket?: string;
	"api-token"?: string;
	url?: string;
	"deploy-token"?: string;
	"project-dir"?: string;
}

async function loadConfig(flags: ParsedFlags, projectDirArg: string): Promise<DeployConfig> {
	return resolveConfig({
		flags: {
			accountId: flags["account-id"],
			bucket: flags.bucket,
			apiToken: flags["api-token"],
			url: flags.url,
			deployToken: flags["deploy-token"],
			projectDir: flags["project-dir"] ?? projectDirArg,
		},
		env: process.env,
	});
}

function printUsage(): void {
	console.error(
		[
			"af — Astroflare CLI",
			"",
			"USAGE",
			"  af <command> [options]",
			"",
			"PROJECT LIFECYCLE",
			"  init <dir>      Scaffold a new Astroflare project",
			"  deploy [dir]    Upload project files to R2 and run the deploy ceremony",
			"  status          Show the active deploy hash",
			"  rollback <hash> Flip /site/current to a previous deploy",
			"",
			"CLOUDFLARE OPERATIONS",
			"  provision <n>   Create a managed Worker + R2 bucket from fixture <n>",
			"  destroy <n>     Destroy a managed Worker and its R2 bucket",
			"  destroy-all     Destroy every Worker managed for the current SHA",
			"  list            List Workers managed for the current SHA",
			"  inspect <n>     Print state for a managed Worker",
			"  health          HEAD each managed URL; report status + latency",
			"  gc              Find orphan workers in the account",
			"",
			"COMMON OPTIONS (deploy / status / rollback)",
			"  --account-id <id>     Cloudflare account ID",
			"  --bucket <name>       R2 bucket name",
			"  --api-token <token>   Cloudflare API token (R2 write scope)",
			"  --url <url>           Project worker URL (e.g. https://my-site.workers.dev)",
			"  --deploy-token <tok>  Bearer token matching env.DEPLOY_TOKEN",
			"  --project-dir <path>  Local project root (default: cwd or first positional)",
			"",
			"ENVIRONMENT",
			"  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN — used as defaults if",
			"  flags are absent. The deploy token defaults to DEPLOY_TOKEN.",
			"  AFLARE_E2E_SHA  — override the SHA used in managed Worker names",
			"  AFLARE_E2E_ROOT — override the repo root used to find fixtures",
			"",
		].join("\n"),
	);
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err) => {
		console.error(`af: ${(err as Error).message}`);
		process.exit(1);
	},
);
