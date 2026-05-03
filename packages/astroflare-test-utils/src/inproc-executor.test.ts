import type { TaskBundle } from "@astroflare/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InProcessExecutor } from "./inproc-executor.js";

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

const echoTask = (greeting: string): TaskBundle => ({
	mainModule: "main.js",
	modules: {
		"main.js": `
			export default async function (input) {
				return ${JSON.stringify(greeting)} + ":" + JSON.stringify(input);
			};
		`,
	},
});

describe("InProcessExecutor", () => {
	let exe: InProcessExecutor;

	beforeEach(() => {
		exe = new InProcessExecutor();
	});

	afterEach(async () => {
		await exe.dispose();
	});

	describe("runOnce produces a fresh isolate", () => {
		it("each call evaluates the module from scratch", async () => {
			const a = (await exe.runOnce<{ n: number }>(counterTask(), null)).n;
			const b = (await exe.runOnce<{ n: number }>(counterTask(), null)).n;
			const c = (await exe.runOnce<{ n: number }>(counterTask(), null)).n;
			// If runOnce shared module state, n would be 1, 2, 3 across calls.
			expect([a, b, c]).toEqual([1, 1, 1]);
		});

		it("input is passed through and result is returned", async () => {
			const r = await exe.runOnce<string>(echoTask("hi"), { x: 42 });
			expect(r).toBe('hi:{"x":42}');
		});

		it("throws if main module has no default export", async () => {
			await expect(
				exe.runOnce(
					{
						mainModule: "main.js",
						modules: { "main.js": "export const x = 1;" },
					},
					null,
				),
			).rejects.toThrow(/default function/);
		});
	});

	describe("runCached", () => {
		it("same id never re-evaluates the module", async () => {
			const a = (await exe.runCached<{ n: number }>("id1", counterTask, null)).n;
			const b = (await exe.runCached<{ n: number }>("id1", counterTask, null)).n;
			const c = (await exe.runCached<{ n: number }>("id1", counterTask, null)).n;
			// Module state persists across calls with the same id.
			expect([a, b, c]).toEqual([1, 2, 3]);
		});

		it("different id = different isolate", async () => {
			const a = (await exe.runCached<{ n: number }>("ida", counterTask, null)).n;
			const b = (await exe.runCached<{ n: number }>("idb", counterTask, null)).n;
			const a2 = (await exe.runCached<{ n: number }>("ida", counterTask, null)).n;
			const b2 = (await exe.runCached<{ n: number }>("idb", counterTask, null)).n;
			expect([a, b, a2, b2]).toEqual([1, 1, 2, 2]);
		});

		it("taskFactory is not called on cache hit (warm-cache contract)", async () => {
			let factoryCalls = 0;
			const factory = (): TaskBundle => {
				factoryCalls++;
				return counterTask();
			};
			await exe.runCached("warm", factory, null);
			await exe.runCached("warm", factory, null);
			await exe.runCached("warm", factory, null);
			expect(factoryCalls).toBe(1);
		});

		it("each call passes a fresh input to the cached module", async () => {
			const t = (): TaskBundle => ({
				mainModule: "main.js",
				modules: {
					"main.js": "export default async function (input) { return input * 10; };",
				},
			});
			expect(await exe.runCached<number>("idx", t, 1)).toBe(10);
			expect(await exe.runCached<number>("idx", t, 5)).toBe(50);
		});

		it("ids are sanitised so /-laden hashes still install cleanly", async () => {
			const r = await exe.runCached<string>("ab/cd:ef", () => echoTask("ok"), 1);
			expect(r).toBe("ok:1");
		});
	});

	describe("multi-module bundle", () => {
		it("supports relative imports between modules in the bundle", async () => {
			const r = await exe.runOnce<string>(
				{
					mainModule: "main.js",
					modules: {
						"main.js": `
							import { greet } from "./greet.js";
							export default async function (input) { return greet(input); };
						`,
						"greet.js": `export const greet = (name) => "hello, " + name;`,
					},
				},
				"world",
			);
			expect(r).toBe("hello, world");
		});

		it("supports nested directory layouts", async () => {
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
});
