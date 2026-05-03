/**
 * `transformTS(source) → string` — strip TypeScript syntax to plain ESM.
 *
 * Backed by esbuild-wasm so the same module runs in Node (Layer A
 * framework tests) and in workerd (Phase 15 Compile DW). Native
 * `esbuild` would be faster on Node but won't run inside a Cloudflare
 * isolate, and the brief's §10 forbids host-specific code in the
 * framework — so esbuild-wasm is the only correct choice for a
 * framework module.
 *
 * Initialisation is lazy and one-shot per process. esbuild-wasm
 * mandates exactly one `initialize()` call; subsequent imports of this
 * module reuse the same instance.
 *
 * Phase 11 carve-out: TS-aware *error* messages aren't yet preserved.
 * esbuild reports errors against the post-transform JS, so a TS error
 * line/column can drift from the original source. Source-map carry-over
 * lands with Phase 13's compiler source-map work.
 */

type EsbuildModule = typeof import("esbuild-wasm");

let cached: EsbuildModule | null = null;
let initPromise: Promise<EsbuildModule> | null = null;

async function ensureInit(): Promise<EsbuildModule> {
	if (cached) return cached;
	if (initPromise) return initPromise;
	initPromise = (async () => {
		const mod = (await import("esbuild-wasm")) as EsbuildModule;
		// `initialize()` is a process-global one-shot. If a parallel test file
		// also imported this module, that import returns the already-initialised
		// module from Node's cache and `mod.transform` is already callable —
		// calling `initialize()` a second time throws. Catch and continue.
		try {
			await mod.initialize({});
		} catch (err) {
			if (!isAlreadyInitialised(err)) throw err;
		}
		cached = mod;
		return mod;
	})();
	return initPromise;
}

function isAlreadyInitialised(err: unknown): boolean {
	if (err instanceof Error) return /already.*initialized/i.test(err.message);
	return false;
}

export interface TransformTsOptions {
	/** Source filename used in error messages and source maps. */
	filename?: string;
	/** Loader hint — defaults to `"ts"`. JSX-bearing files pass `"tsx"`. */
	loader?: "ts" | "tsx";
}

/**
 * Strip TS syntax to plain ESM. JS-only source passes through (the `ts`
 * loader treats JS as a TS subset). Top-level `import`/`export` shape
 * is preserved.
 */
export async function transformTS(source: string, opts: TransformTsOptions = {}): Promise<string> {
	const mod = await ensureInit();
	const result = await mod.transform(source, {
		loader: opts.loader ?? "ts",
		target: "es2022",
		format: "esm",
		sourcefile: opts.filename,
		// Don't introduce helper imports — the inline bundler later strips
		// remaining imports anyway, but keeping output closure-free is
		// friendlier to the bundler's regex-based rewrites.
		treeShaking: false,
	});
	return result.code;
}

/**
 * Sync entry point used by tests / tools that already awaited an init.
 * Throws if `transformTS` hasn't been awaited at least once. Exposed so
 * a future Phase 13 (source-map work) can build a faster sync path.
 */
export function transformTSSync(source: string, opts: TransformTsOptions = {}): string {
	if (!cached) {
		throw new Error("transformTSSync: call transformTS() once first to initialise esbuild-wasm");
	}
	const result = cached.transformSync(source, {
		loader: opts.loader ?? "ts",
		target: "es2022",
		format: "esm",
		sourcefile: opts.filename,
		treeShaking: false,
	});
	return result.code;
}

/** Test-affordance: reset cache so tests can simulate a cold start. */
export function __resetEsbuildForTests(): void {
	cached = null;
	initPromise = null;
}
