import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "./doctor.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "aflare-doctor-test-"));
	mkdirSync(join(tmp, ".git"), { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("doctor", () => {
	it("flags missing credentials with stable check ids", async () => {
		const report = await doctor({ rootDir: tmp, env: {} });
		expect(report.ok).toBe(false);
		const idsToOk = new Map(report.checks.map((c) => [c.id, c.ok]));
		expect(idsToOk.get("credentials.account_id")).toBe(false);
		expect(idsToOk.get("credentials.api_token")).toBe(false);
	});

	it("ok=true when creds present, state dir exists, git repo exists", async () => {
		mkdirSync(join(tmp, "tests/e2e/.state/abc1234"), { recursive: true });
		const report = await doctor({
			rootDir: tmp,
			env: {
				CLOUDFLARE_ACCOUNT_ID: "acc",
				CLOUDFLARE_API_TOKEN: "tok",
				AFLARE_SHA: "abc1234",
			},
			clientFactory: () => fakeClient(true),
		});
		expect(report.ok).toBe(true);
		expect(report.checks.find((c) => c.id === "credentials.token.verified")?.ok).toBe(true);
		expect(report.checks.find((c) => c.id === "state.dir")?.ok).toBe(true);
		expect(report.checks.find((c) => c.id === "env.git_repo")?.ok).toBe(true);
	});

	it("token verification failure surfaces as a structured check", async () => {
		mkdirSync(join(tmp, "tests/e2e/.state/abc1234"), { recursive: true });
		const report = await doctor({
			rootDir: tmp,
			env: {
				CLOUDFLARE_ACCOUNT_ID: "acc",
				CLOUDFLARE_API_TOKEN: "tok",
				AFLARE_SHA: "abc1234",
			},
			clientFactory: () => fakeClient(false),
		});
		const tokenCheck = report.checks.find((c) => c.id === "credentials.token.verified");
		expect(tokenCheck?.ok).toBe(false);
		expect(tokenCheck?.context?.error).toBeDefined();
	});
});

// Minimal fake CloudflareClient — only `getAccountSubdomain` is used by doctor.
function fakeClient(succeed: boolean): {
	getAccountSubdomain(): Promise<string>;
} & Record<string, unknown> {
	return {
		async getAccountSubdomain() {
			if (succeed) return "myteam";
			throw new Error("token rejected");
		},
	} as { getAccountSubdomain(): Promise<string> } & Record<string, unknown>;
}
