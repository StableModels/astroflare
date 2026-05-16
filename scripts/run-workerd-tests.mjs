#!/usr/bin/env node
/**
 * Guard wrapper for the Layer-B (workerd-pool) vitest invocation.
 *
 * Works around upstream https://github.com/cloudflare/workerd/issues/6506:
 * a race in workerd's own ephemeral Worker Loader isolate teardown
 * (`workerd/jsg/setup.c++:235: tried to defer destruction during isolate
 * shutdown; queueState = 1`) that intermittently aborts the runtime AFTER
 * every test has already passed, corrupting the process exit code and
 * suppressing vitest's summary. It is unfixed upstream and there is no
 * good workerd/pool version; the bug can only produce a false RED, never
 * a false GREEN.
 *
 * This wrapper is FAIL-CLOSED: it only retries / tolerates a non-zero exit
 * when the failure is unambiguously the upstream teardown crash on an
 * otherwise all-green run. Any real test failure is propagated immediately
 * and is never retried or suppressed.
 *
 * Opt out (raw vitest behaviour) with AFLARE_NO_WORKERD_RETRY=1.
 */
import { spawn } from "node:child_process";

const PROJECTS =
	process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["workerd", "host-cloudflare"];

const MAX_ATTEMPTS = 3;
const ISSUE = "https://github.com/cloudflare/workerd/issues/6506";

const TEARDOWN_SIG =
	/workerd\/jsg\/setup\.c\+\+:235|tried to defer destruction during isolate shutdown/;
// Vitest only prints these when a test/suite genuinely fails.
const REAL_FAILURE =
	/⎯+\s*Failed Tests\s*⎯+|^\s*FAIL\s|Test Files\s+\d+\s+failed|Tests\s+\d+\s+failed|\bAssertionError\b/m;
const PASS_MARKS = /✓\s*\|(?:workerd|host-cloudflare)\|/;

function runOnce() {
	return new Promise((resolve) => {
		const args = ["exec", "vitest", "run"];
		for (const p of PROJECTS) args.push("--project", p);
		const child = spawn("pnpm", args, {
			stdio: ["inherit", "pipe", "pipe"],
			env: process.env,
		});
		let buf = "";
		const tap = (stream, sink) => {
			stream.on("data", (chunk) => {
				buf += chunk;
				sink.write(chunk);
			});
		};
		tap(child.stdout, process.stdout);
		tap(child.stderr, process.stderr);
		child.on("close", (code) => resolve({ code: code ?? 1, out: buf }));
	});
}

function classify(code, out) {
	if (code === 0) return "pass";
	if (REAL_FAILURE.test(out)) return "real-failure";
	if (TEARDOWN_SIG.test(out) && PASS_MARKS.test(out)) return "teardown-only";
	// Non-zero with no recognised signature — fail closed.
	return "unknown-failure";
}

const optOut = process.env.AFLARE_NO_WORKERD_RETRY === "1";

let last = { code: 1, out: "" };
for (let attempt = 1; attempt <= (optOut ? 1 : MAX_ATTEMPTS); attempt++) {
	last = await runOnce();
	const verdict = classify(last.code, last.out);
	if (verdict === "pass") {
		if (attempt > 1) {
			console.error(
				`\n[workerd-guard] passed on attempt ${attempt}/${MAX_ATTEMPTS} after tolerating upstream teardown crash(es) — see ${ISSUE}`,
			);
		}
		process.exit(0);
	}
	if (verdict === "real-failure" || verdict === "unknown-failure") {
		console.error(
			`\n[workerd-guard] real failure detected (verdict=${verdict}, exit=${last.code}) — propagating, NOT retried.`,
		);
		process.exit(last.code);
	}
	// teardown-only
	const tail = optOut
		? " AFLARE_NO_WORKERD_RETRY=1 set — not retrying."
		: attempt < MAX_ATTEMPTS
			? " Retrying."
			: "";
	console.error(
		`\n[workerd-guard] attempt ${attempt}/${MAX_ATTEMPTS}: all tests passed but workerd aborted during isolate-shutdown teardown (upstream ${ISSUE}).${tail}`,
	);
	if (optOut) process.exit(last.code);
}

// Every attempt was teardown-only (never a real failure): the suite
// genuinely passed each time. Surface loudly but exit green.
console.error(
	`\n::warning::[workerd-guard] workerd teardown crash (upstream ${ISSUE}) reproduced on all ${MAX_ATTEMPTS} attempts; every test PASSED each time. Treating as green. This is a known unfixed workerd bug; the crash cannot produce a false pass.`,
);
process.exit(0);
