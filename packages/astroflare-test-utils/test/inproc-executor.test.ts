import type { TaskBundle } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import { InProcessExecutor } from "../src/inproc-executor.js";

const identityTask: TaskBundle = {
  mainModule: "main.js",
  modules: {
    "main.js": "module.exports = (input) => input;",
  },
};

function adderTask(): TaskBundle {
  return {
    mainModule: "main.js",
    modules: {
      "main.js": `
        const helper = require('./helper');
        module.exports = (input) => helper.add(input.a, input.b);
      `,
      "./helper": `
        module.exports.add = (a, b) => a + b;
      `,
    },
  };
}

describe("InProcessExecutor", () => {
  it("runOnce returns the task's result", async () => {
    const ex = new InProcessExecutor();
    const out = await ex.runOnce<{ x: number }>(identityTask, { x: 7 });
    expect(out).toEqual({ x: 7 });
  });

  it("runOnce supports a virtual require for sub-modules", async () => {
    const ex = new InProcessExecutor();
    const sum = await ex.runOnce<number>(adderTask(), { a: 3, b: 4 });
    expect(sum).toBe(7);
  });

  it("runCached invokes the factory at most once per id", async () => {
    const ex = new InProcessExecutor();
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return identityTask;
    };
    const a = await ex.runCached<number>("id-a", factory, 1);
    const b = await ex.runCached<number>("id-a", factory, 2);
    const c = await ex.runCached<number>("id-a", factory, 3);
    expect([a, b, c]).toEqual([1, 2, 3]);
    expect(factoryCalls).toBe(1);
    expect(ex.telemetry.factoryInvocations).toBe(1);
    expect(ex.cachedIds()).toEqual(["id-a"]);
  });

  it("runCached treats different ids as separate isolates", async () => {
    const ex = new InProcessExecutor();
    let factoryCalls = 0;
    const factory = (k: number) => () => {
      factoryCalls++;
      return {
        mainModule: "m.js",
        modules: { "m.js": `module.exports = () => ${k};` },
      } satisfies TaskBundle;
    };
    const a = await ex.runCached<number>("a", factory(1), null);
    const b = await ex.runCached<number>("b", factory(2), null);
    const a2 = await ex.runCached<number>("a", factory(99), null); // factory ignored
    expect([a, b, a2]).toEqual([1, 2, 1]);
    expect(factoryCalls).toBe(2);
  });

  it("runOnce always spawns a fresh isolate, never reuses prior state", async () => {
    const ex = new InProcessExecutor();
    const stateful: TaskBundle = {
      mainModule: "main.js",
      modules: {
        "main.js": `
          if (globalThis.__counter == null) globalThis.__counter = 0;
          globalThis.__counter++;
          module.exports = () => globalThis.__counter;
        `,
      },
    };
    const a = await ex.runOnce<number>(stateful, null);
    const b = await ex.runOnce<number>(stateful, null);
    expect(a).toBe(1);
    expect(b).toBe(1); // fresh worker -> counter starts at 0 again
  });

  it("propagates user errors from the task with a useful message", async () => {
    const ex = new InProcessExecutor();
    const bad: TaskBundle = {
      mainModule: "main.js",
      modules: {
        "main.js": "module.exports = () => { throw new Error('boom'); };",
      },
    };
    await expect(ex.runOnce(bad, null)).rejects.toThrow(/boom/);
  });

  it("rejects if the task references a missing module", async () => {
    const ex = new InProcessExecutor();
    const bad: TaskBundle = {
      mainModule: "main.js",
      modules: {
        "main.js": "module.exports = () => require('./missing');",
      },
    };
    await expect(ex.runOnce(bad, null)).rejects.toThrow(/Module not found/);
  });

  it("rejects synchronously when mainModule is not in modules", async () => {
    const ex = new InProcessExecutor();
    await expect(ex.runOnce({ mainModule: "ghost.js", modules: {} }, null)).rejects.toThrow(
      /mainModule 'ghost.js' is not present/,
    );
  });

  it("supports async task functions", async () => {
    const ex = new InProcessExecutor();
    const asyncTask: TaskBundle = {
      mainModule: "main.js",
      modules: {
        "main.js": `
          module.exports = async (input) => {
            await new Promise(r => setTimeout(r, 5));
            return input * 2;
          };
        `,
      },
    };
    expect(await ex.runOnce<number>(asyncTask, 21)).toBe(42);
  });

  it("supports the .default and .run export shapes", async () => {
    const ex = new InProcessExecutor();
    const defaultTask: TaskBundle = {
      mainModule: "m.js",
      modules: { "m.js": "module.exports.default = (i) => i + 1;" },
    };
    const runTask: TaskBundle = {
      mainModule: "m.js",
      modules: { "m.js": "module.exports.run = (i) => i + 2;" },
    };
    expect(await ex.runOnce<number>(defaultTask, 10)).toBe(11);
    expect(await ex.runOnce<number>(runTask, 10)).toBe(12);
  });
});
