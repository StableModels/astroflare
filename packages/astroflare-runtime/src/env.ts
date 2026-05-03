/**
 * `astro:env` runtime helpers (Phase 15a).
 *
 * `getSecret(name)` reads a value from the per-request environment that
 * the project worker bound via `withEnvContext`. Mirrors Astro's
 * `astro:env/server` surface — server-only, never inlined into client
 * bundles, never substituted at compile time.
 *
 * Distinct from Phase 12's `import.meta.env.<KEY>` substitution:
 *   - `import.meta.env.PUBLIC_X` is replaced *at compile time* with the
 *     literal value (so it's safe in client code, but the value is
 *     baked into every artifact).
 *   - `getSecret("X")` resolves *at request time* against the worker's
 *     bound env (so secrets stay in the Worker's secret store and
 *     don't leak into compiled bundles).
 *
 * Implementation: a per-request `AsyncLocalStorage` slot. The project
 * worker's fetch handler wraps each request with `withEnvContext(env)`
 * so any code running *in the parent worker isolate* reads the bound
 * env. That covers the deploy endpoint, hybrid-serving routing, the
 * preview server's request scaffolding — everything before the
 * Worker Loader spawn.
 *
 * **Cross-isolate caveat (Phase 15a carve-out):** ALS doesn't propagate
 * across isolate boundaries. User-authored middleware / endpoints /
 * SSR frontmatter run in Worker Loader-spawned child isolates and
 * call `getSecret(name)` on a *fresh* ALS that has nothing bound, so
 * they get `undefined`. Threading env values into the spawned task's
 * JSON-marshaled context is the right fix; deferred to a follow-on
 * phase.
 *
 * The ALS pattern is the same one `internal.ts` uses for the
 * per-request render context. Works in workerd under
 * `nodejs_compat`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request environment record — an opaque map of name → value. */
export type EnvContext = Readonly<Record<string, string | undefined>>;

const envStore = new AsyncLocalStorage<EnvContext>();

/**
 * Run `fn` with `env` bound as the current request's environment.
 * Calls to `getSecret(name)` inside `fn` (or anything `fn` awaits)
 * see `env`. Outside the scope, `getSecret` returns `undefined`.
 *
 * If `fn` returns a Promise, the bound env propagates across awaits
 * via `AsyncLocalStorage`'s integration with async hooks. The caller
 * awaits the returned Promise as usual.
 */
export function withEnvContext<R>(env: EnvContext, fn: () => R): R {
	return envStore.run(env, fn);
}

/**
 * Read a secret by name from the current request's environment.
 * Returns `undefined` when called outside a `withEnvContext` scope or
 * when the name isn't present in the bound env. Never throws — callers
 * decide whether a missing secret is fatal.
 */
export function getSecret(name: string): string | undefined {
	const env = envStore.getStore();
	return env?.[name];
}

/**
 * Read every name-value pair in the current environment. Convenience
 * for tests / debugging — production code should reach for individual
 * secrets via `getSecret`.
 */
export function getEnvContext(): EnvContext | undefined {
	return envStore.getStore();
}
