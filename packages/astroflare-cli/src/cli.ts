#!/usr/bin/env node
/**
 * `aflare` — Astroflare CLI entrypoint.
 *
 * Subcommands:
 *
 *   aflare deploy [dir]     Walk project files, upload to R2 via the
 *                           Cloudflare API, then POST to /_aflare/deploy
 *                           on the project worker to render the static
 *                           routes and flip /site/current.
 *
 *   aflare status           GET /_aflare/deploy/status from the project
 *                           worker. Prints the active deploy hash.
 *
 *   aflare rollback <hash>  Re-flip /site/current to a previous deploy
 *                           hash. Dangerous; intentionally distinct
 *                           from `deploy` so it isn't a one-character
 *                           typo away.
 *
 * Configuration is resolved from (in priority order):
 *   1. CLI flags (e.g. `--account-id`)
 *   2. Environment variables (CLOUDFLARE_API_TOKEN etc.)
 *   3. `aflare.config.json` in the project root
 *
 * Output goes to stdout as one-line JSON for scriptability; human
 * progress messages go to stderr.
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { Cli as E2eCli } from "@astroflare/e2e";
import { type DeployConfig, resolveConfig } from "./commands/deploy.js";
import { cmdDeploy, cmdRollback, cmdStatus } from "./commands/deploy.js";
import { initProject } from "./commands/init.js";

async function main(argv: readonly string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === "--help" || subcommand === "-h") {
		printUsage();
		return 0;
	}

	switch (subcommand) {
		case "init":
			return runInit(rest);
		case "deploy":
			return runDeploy(rest);
		case "status":
			return runStatus(rest);
		case "rollback":
			return runRollback(rest);
		case "e2e":
			return runE2e(rest);
		case "--version":
		case "-v":
			console.log("aflare 0.0.0");
			return 0;
		default:
			console.error(`aflare: unknown subcommand '${subcommand}'\n`);
			printUsage();
			return 1;
	}
}

/**
 * `aflare e2e <verb>` — orchestrate end-to-end tests against live
 * Cloudflare. Delegates to `@astroflare/e2e`'s CLI dispatcher so
 * the verb surface (`provision`, `teardown`, `teardown-all`,
 * `list`, `inspect`, `status`, `gc`) lives in one place.
 *
 * Reads `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` from env;
 * `AFLARE_E2E_SHA` overrides the SHA used in resource names
 * (default: `git rev-parse --short=7 HEAD`); `AFLARE_E2E_ROOT`
 * overrides the repo root (default: cwd).
 */
async function runE2e(argv: readonly string[]): Promise<number> {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	if (!accountId) {
		console.error("aflare e2e: CLOUDFLARE_ACCOUNT_ID is required");
		return 2;
	}
	if (!apiToken) {
		console.error("aflare e2e: CLOUDFLARE_API_TOKEN is required");
		return 2;
	}
	const sha7 =
		process.env.AFLARE_E2E_SHA ?? execSync("git rev-parse --short=7 HEAD").toString().trim();
	const rootDir = process.env.AFLARE_E2E_ROOT ?? process.cwd();
	const cli = new E2eCli({
		env: {
			rootDir,
			sha7,
			cloudflareAccountId: accountId,
			cloudflareApiToken: apiToken,
		},
	});
	return await cli.run(argv);
}

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
		console.error("aflare init: missing <dir> argument");
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
		console.error(`aflare init: ${(err as Error).message}`);
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
		console.error("aflare rollback: missing <hash> argument");
		return 1;
	}
	const cfg = await loadConfig(values, ".");
	const result = await cmdRollback(cfg, hash);
	console.log(JSON.stringify(result));
	return 0;
}

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
			"aflare — Astroflare CLI",
			"",
			"USAGE",
			"  aflare <command> [options]",
			"",
			"COMMANDS",
			"  init <dir>      Scaffold a new Astroflare project in <dir>",
			"  deploy [dir]    Upload project files to R2 and run the deploy ceremony",
			"  status          Show the active deploy hash",
			"  rollback <hash> Flip /site/current to a previous deploy",
			"",
			"  e2e <verb>      Orchestrate end-to-end tests against live Cloudflare",
			"                  Verbs: provision, teardown, teardown-all, list,",
			"                         inspect, status, gc",
			"",
			"COMMON OPTIONS",
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
			"",
		].join("\n"),
	);
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err) => {
		console.error(`aflare: ${(err as Error).message}`);
		process.exit(1);
	},
);
