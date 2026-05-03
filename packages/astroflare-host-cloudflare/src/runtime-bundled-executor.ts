/**
 * `createWorkerdExecutor` — `WorkerdExecutor` that auto-merges a host-
 * supplied runtime modules map into every spawned isolate's module map
 * (Phase 26).
 *
 * Replaces the Phase 25 `__AFLARE_RUNTIME_MODULES__` build-time
 * substitution. The host bundles the runtime (typically by reading
 * `node_modules/@astroflare/runtime/dist/*.js` at build time) and passes
 * it in at construction. Spawned compile/render isolates resolve
 * `import { render } from "./runtime/index.js"` against the inlined
 * runtime modules.
 */

import type { Executor, TaskBundle } from "@astroflare/core";
import { WorkerdExecutor, type WorkerdExecutorOptions } from "./executor.js";

export interface CreateWorkerdExecutorOptions extends WorkerdExecutorOptions {
	/**
	 * Runtime modules merged into every TaskBundle. Keys should be paths
	 * the spawned shim imports — e.g. `"runtime/index.js"`,
	 * `"runtime/internal.js"`. User modules win on collision; the
	 * `runtime/*` namespace is reserved by convention.
	 */
	runtime?: Record<string, string>;
}

export function createWorkerdExecutor(opts: CreateWorkerdExecutorOptions): Executor {
	const base = new WorkerdExecutor(opts);
	const runtime = opts.runtime ?? {};
	if (Object.keys(runtime).length === 0) return base;
	return {
		async runOnce<R>(task: TaskBundle, input: unknown): Promise<R> {
			return base.runOnce<R>(merge(task, runtime), input);
		},
		async runCached<R>(id: string, factory: () => TaskBundle, input: unknown): Promise<R> {
			return base.runCached<R>(id, () => merge(factory(), runtime), input);
		},
	};
}

function merge(task: TaskBundle, runtime: Record<string, string>): TaskBundle {
	return {
		...task,
		modules: { ...runtime, ...task.modules },
	};
}
