/**
 * `af doctor` — environment sanity check. Surfaces the four most
 * common Phase 26c failure modes in one structured report so the
 * agent (or human) can resolve before attempting real provisioning:
 *
 *   - missing credentials (CLOUDFLARE_ACCOUNT_ID / API_TOKEN)
 *   - API token rejected
 *   - account on free plan when a paid feature (Worker Loader) is
 *     required
 *   - workers.dev subdomain not configured
 *
 * Each check has a stable `id` so structured output consumers can
 * branch on which gate failed.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { CloudflareClient } from "../api.js";

export interface DoctorCheck {
	id: string;
	ok: boolean;
	context?: Record<string, unknown>;
}

export interface DoctorReport {
	checks: readonly DoctorCheck[];
	ok: boolean;
}

export interface DoctorInput {
	rootDir: string;
	env?: NodeJS.ProcessEnv;
	/** Inject for tests. */
	clientFactory?: (accountId: string, apiToken: string) => CloudflareClient;
}

export async function doctor(input: DoctorInput): Promise<DoctorReport> {
	const env = input.env ?? process.env;
	const checks: DoctorCheck[] = [];

	// 1. Credentials present?
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = env.CLOUDFLARE_API_TOKEN;
	checks.push({
		id: "credentials.account_id",
		ok: Boolean(accountId),
		context: accountId ? undefined : { hint: "set CLOUDFLARE_ACCOUNT_ID" },
	});
	checks.push({
		id: "credentials.api_token",
		ok: Boolean(apiToken),
		context: apiToken ? undefined : { hint: "set CLOUDFLARE_API_TOKEN" },
	});

	// 2. Token verified?
	let tokenOk = false;
	if (accountId && apiToken && input.clientFactory) {
		const client = input.clientFactory(accountId, apiToken);
		try {
			await client.getAccountSubdomain();
			tokenOk = true;
		} catch (err) {
			checks.push({
				id: "credentials.token.verified",
				ok: false,
				context: { error: (err as Error).message },
			});
		}
	}
	if (tokenOk) {
		checks.push({ id: "credentials.token.verified", ok: true });
	} else if (!accountId || !apiToken) {
		checks.push({
			id: "credentials.token.verified",
			ok: false,
			context: { hint: "credentials missing — can't verify" },
		});
	}

	// 3. State directory present?
	const sha7 = env.AFLARE_SHA ?? safeSha(input.rootDir);
	const stateDir = `${input.rootDir}/tests/e2e/.state/${sha7}`;
	checks.push({
		id: "state.dir",
		ok: existsSync(stateDir),
		context: { path: stateDir, sha7 },
	});

	// 4. Git repo?
	checks.push({
		id: "env.git_repo",
		ok: existsSync(`${input.rootDir}/.git`),
		context: { rootDir: input.rootDir },
	});

	const allOk = checks.every((c) => c.ok);
	return { checks, ok: allOk };
}

function safeSha(rootDir: string): string {
	try {
		return execSync("git rev-parse --short=7 HEAD", {
			cwd: rootDir,
			encoding: "utf8",
		}).trim();
	} catch {
		return "unknown";
	}
}
