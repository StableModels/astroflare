/**
 * `WorkerdExecutor` against real workerd via Worker Loader.
 *
 * Mirrors the property tests in `packages/astroflare-test-utils/src/inproc-executor.test.ts`
 * — same invariants the brief's §7.1 spelled out, now under isolate-faithful
 * conditions:
 *
 *   - `runOnce` produces a fresh isolate (counter doesn't survive)
 *   - `runCached(id)` returns the same logical module/isolate (counter
 *     persists across invocations of the same id)
 *   - different ids produce different isolates
 *   - error in user code surfaces as a thrown `Error` to the parent
 *   - multi-module bundle resolves intra-bundle imports natively (no
 *     vite-node intercept — that's the whole point of this layer)
 */
import { env } from "cloudflare:test";
import type { TaskBundle } from "@astroflare/core";
import { WorkerdExecutor } from "@astroflare/host-cloudflare";
import { describe, expect, it } from "vitest";

const counterTask = (): TaskBundle => ({
	mainModule: "main.js",
	modules: {
		"main.js": `
			let n = 0;
			export default async function (input) {
				n += 1;
				return { n, input };
			};
		`,
	},
});

function makeExecutor(): WorkerdExecutor {
	return new WorkerdExecutor({
		loader: env.LOADER,
		compatibilityDate: "2025-09-01",
	});
}

describe("WorkerdExecutor.runOnce", () => {
	it("each call evaluates the module from scratch (counter stays at 1)", async () => {
		const exe = makeExecutor();
		const a = (await exe.runOnce<{ n: number }>(counterTask(), null)).n;
		const b = (await exe.runOnce<{ n: number }>(counterTask(), null)).n;
		const c = (await exe.runOnce<{ n: number }>(counterTask(), null)).n;
		expect([a, b, c]).toEqual([1, 1, 1]);
	});

	it("input is passed through and result is returned", async () => {
		const exe = makeExecutor();
		const r = await exe.runOnce<string>(
			{
				mainModule: "main.js",
				modules: {
					"main.js":
						'export default async function (input) { return "hi:" + JSON.stringify(input); };',
				},
			},
			{ x: 42 },
		);
		expect(r).toBe('hi:{"x":42}');
	});

	it("propagates user-thrown errors as Error in the parent", async () => {
		const exe = makeExecutor();
		await expect(
			exe.runOnce(
				{
					mainModule: "main.js",
					modules: {
						"main.js": "export default () => { throw new Error('boom'); };",
					},
				},
				null,
			),
		).rejects.toThrow(/boom/);
	});
});

describe("WorkerdExecutor.runCached", () => {
	it("same id reuses the loaded module — module state persists", async () => {
		const exe = makeExecutor();
		const a = (await exe.runCached<{ n: number }>("counter-a", counterTask, null)).n;
		const b = (await exe.runCached<{ n: number }>("counter-a", counterTask, null)).n;
		const c = (await exe.runCached<{ n: number }>("counter-a", counterTask, null)).n;
		expect([a, b, c]).toEqual([1, 2, 3]);
	});

	it("different id = different isolate (no shared state)", async () => {
		const exe = makeExecutor();
		const a = (await exe.runCached<{ n: number }>("p-a", counterTask, null)).n;
		const b = (await exe.runCached<{ n: number }>("p-b", counterTask, null)).n;
		const a2 = (await exe.runCached<{ n: number }>("p-a", counterTask, null)).n;
		const b2 = (await exe.runCached<{ n: number }>("p-b", counterTask, null)).n;
		expect([a, b, a2, b2]).toEqual([1, 1, 2, 2]);
	});

	it("each call passes a fresh input to the cached module", async () => {
		const exe = makeExecutor();
		const t = (): TaskBundle => ({
			mainModule: "main.js",
			modules: {
				"main.js": "export default async function (input) { return input * 10; };",
			},
		});
		expect(await exe.runCached<number>("times-ten", t, 1)).toBe(10);
		expect(await exe.runCached<number>("times-ten", t, 5)).toBe(50);
	});
});

describe("WorkerdExecutor: multi-module", () => {
	it("supports relative imports between bundle modules", async () => {
		const exe = makeExecutor();
		const r = await exe.runOnce<string>(
			{
				mainModule: "main.js",
				modules: {
					"main.js": `
						import { greet } from "./greet.js";
						export default async function (input) { return greet(input); };
					`,
					"greet.js": "export const greet = (name) => 'hello, ' + name;",
				},
			},
			"world",
		);
		expect(r).toBe("hello, world");
	});

	it("supports nested directory layouts", async () => {
		const exe = makeExecutor();
		const r = await exe.runOnce<number>(
			{
				mainModule: "main.js",
				modules: {
					"main.js": `
						import { add } from "./util/math.js";
						export default async function (input) { return add(input, 1); };
					`,
					"util/math.js": "export const add = (a, b) => a + b;",
				},
			},
			41,
		);
		expect(r).toBe(42);
	});
});

describe("WorkerdExecutor: large-bundle threshold", () => {
	it("logs `large-bundle` when total module bytes exceed maxInlineBytes", async () => {
		const events: { name: string; fields: Record<string, unknown> }[] = [];
		const exe = new WorkerdExecutor({
			loader: env.LOADER,
			compatibilityDate: "2025-09-01",
			maxInlineBytes: 50,
			logger: { event: (name, fields) => events.push({ name, fields }) },
		});
		const big = "x".repeat(200);
		await exe.runOnce(
			{
				mainModule: "main.js",
				modules: {
					"main.js": `
						const big = ${JSON.stringify(big)};
						export default async function () { return big.length; };
					`,
				},
			},
			null,
		);
		const warn = events.find((e) => e.name === "workerd-executor.large-bundle");
		expect(warn).toBeDefined();
		expect(warn?.fields.bytes).toBeGreaterThan(50);
	});
});
