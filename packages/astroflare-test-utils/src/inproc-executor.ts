import { Worker } from "node:worker_threads";
import type { Executor, TaskBundle } from "@astroflare/core";

const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads');
const { mainModule, modules, input } = workerData;

const cache = new Map();
function vrequire(spec) {
  if (cache.has(spec)) return cache.get(spec);
  if (!Object.prototype.hasOwnProperty.call(modules, spec)) {
    throw new Error('Module not found in TaskBundle: ' + spec);
  }
  const exportsObj = {};
  const moduleObj = { exports: exportsObj };
  cache.set(spec, exportsObj);
  const source = modules[spec];
  const fn = new Function('require', 'module', 'exports', source);
  fn(vrequire, moduleObj, exportsObj);
  cache.set(spec, moduleObj.exports);
  return moduleObj.exports;
}

(async () => {
  try {
    const m = vrequire(mainModule);
    let fn;
    if (typeof m === 'function') fn = m;
    else if (m && typeof m.default === 'function') fn = m.default;
    else if (m && typeof m.run === 'function') fn = m.run;
    else throw new Error('TaskBundle main module must export a function (module.exports = fn, .default, or .run)');
    const result = await fn(input);
    parentPort.postMessage({ ok: true, result });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e), stack: e && e.stack });
  }
})();
`;

interface ExecutorTelemetry {
  runOnceCalls: number;
  runCachedCalls: number;
  factoryInvocations: number;
}

/**
 * In-process Executor: each task runs in a fresh `worker_threads.Worker`,
 * which gives us a real V8 isolate for isolation properties without depending
 * on workerd. The contract intentionally matches the Cloudflare Worker Loader
 * binding: `runOnce` always spins fresh; `runCached` caches the *bundle* by
 * id (the factory is invoked at most once per id) but each invocation still
 * runs in a fresh worker.
 *
 * Modules in `TaskBundle.modules` are loaded via a CommonJS-style virtual
 * require. The main module must export a function via `module.exports = fn`,
 * `default`, or `run`. The function receives the `input` arg and may be async.
 */
export class InProcessExecutor implements Executor {
  private readonly bundleCache = new Map<string, TaskBundle>();
  readonly telemetry: ExecutorTelemetry = {
    runOnceCalls: 0,
    runCachedCalls: 0,
    factoryInvocations: 0,
  };

  async runOnce<R>(task: TaskBundle, input: unknown): Promise<R> {
    this.telemetry.runOnceCalls++;
    return this.execute<R>(task, input);
  }

  async runCached<R>(id: string, taskFactory: () => TaskBundle, input: unknown): Promise<R> {
    this.telemetry.runCachedCalls++;
    let bundle = this.bundleCache.get(id);
    if (!bundle) {
      this.telemetry.factoryInvocations++;
      bundle = taskFactory();
      this.bundleCache.set(id, bundle);
    }
    return this.execute<R>(bundle, input);
  }

  private execute<R>(task: TaskBundle, input: unknown): Promise<R> {
    if (!Object.prototype.hasOwnProperty.call(task.modules, task.mainModule)) {
      return Promise.reject(
        new Error(`TaskBundle.mainModule '${task.mainModule}' is not present in modules`),
      );
    }
    return new Promise<R>((resolve, reject) => {
      const worker = new Worker(WORKER_BOOTSTRAP, {
        eval: true,
        workerData: { mainModule: task.mainModule, modules: task.modules, input },
      });
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
        worker.terminate().catch(() => {});
      };
      worker.once(
        "message",
        (msg: { ok: boolean; result?: unknown; error?: string; stack?: string }) => {
          if (msg.ok) settle(() => resolve(msg.result as R));
          else
            settle(() => {
              const err = new Error(msg.error ?? "task error");
              if (msg.stack) err.stack = msg.stack;
              reject(err);
            });
        },
      );
      worker.once("error", (err) => settle(() => reject(err)));
      worker.once("exit", (code) => {
        if (!settled) {
          settled = true;
          reject(new Error(`task worker exited with code ${code} before posting a result`));
        }
      });
    });
  }

  /** Test helper: drop the bundle cache. */
  clearCache(): void {
    this.bundleCache.clear();
  }

  /** Test helper: snapshot of cached ids. */
  cachedIds(): string[] {
    return [...this.bundleCache.keys()];
  }
}
