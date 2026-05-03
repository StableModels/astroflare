/**
 * Module graph + per-module compile cache.
 *
 * Sits on top of `Coordinator.graph*` (Phase 1) and `Storage.cacheRead/Write`
 * (the cache subspace from §5.2). The Coordinator owns the in-memory graph
 * shape (nodes, reverse edges, invalidation walk); this layer adds the
 * framework-side compile semantics:
 *
 *   - `compile(path)` — read source, content-hash, look up the compile cache
 *     keyed by `contentIdWithConfig(source, transformConfig)`. On miss,
 *     invoke `compileAstro`, store result in cache. Return source/compiled/
 *     resolved-imports record. Updates the Coordinator's graph node.
 *
 *   - `closure(rootPath)` — DFS the import graph starting at `rootPath`,
 *     compiling each module. Returns the modules in a deterministic order
 *     plus an aggregate `bundleKey` (the per-bundle cache id used for
 *     `Executor.runCached`).
 *
 * Two cache layers (per §5.3 "Content addressing everywhere"):
 *   - **per-module compile cache** in `Storage.cacheWrite/cacheRead` — keyed
 *     by `contentIdWithConfig(source, {compiler, runtimeImport})`. Survives
 *     Coordinator restarts (the brief calls this out specifically).
 *   - **per-bundle execution cache** via `Executor.runCached` — keyed by
 *     the aggregate of every module's compile key (so a dep change
 *     invalidates the bundle even when the route itself didn't change).
 *
 * Phase 4 carve-outs (documented in the retro):
 *   - cycle-safe DFS, but cycles produce one valid ordering only — not the
 *     traversal Astro itself does. Real cycle handling is a Phase 6+ concern.
 *   - per-path compile concurrency uses a Map<path, Promise> "in-flight"
 *     guard — second concurrent caller for the same path awaits the first's
 *     result; no double-compile, no double-cacheWrite.
 *   - only `.astro` imports are followed. Other extensions (`.ts`, `.js`,
 *     `.css`, etc.) are not compiled or bundled — Phase 6/8 work.
 */

import { COMPILER_VERSION, compileAstro, compileMarkdown } from "@astroflare/compiler";
import {
	type Host,
	type ImageMetadata,
	type ModuleNode,
	contentId,
	contentIdWithConfig,
	dirname,
	joinPath,
} from "@astroflare/core";
import { extractImports } from "./url-rewrite.js";

const ASTRO_EXT = ".astro";
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif|avif|svg|ico)$/i;
const dec = new TextDecoder();
const enc = new TextEncoder();

export interface ModuleInfo {
	/** Workspace path, e.g. `/src/pages/index.astro`. */
	path: string;
	/** Content hash of the raw source bytes. */
	sourceHash: string;
	/** Cache key used by Storage's compile cache (source + transform config). */
	compileKey: string;
	/** Compiled ESM. */
	compiled: string;
	/** Resolved workspace paths of every `.astro` import in the compiled output. */
	resolvedImports: readonly string[];
}

export interface ModuleGraphOptions {
	/** Module specifier the compiled output uses for the runtime ABI imports. */
	runtimeImport: string;
	/**
	 * Optional `import.meta.env` substitutions threaded into compileAstro.
	 * The cache key includes a digest of these so a config change
	 * invalidates compiled artifacts.
	 */
	env?: Record<string, unknown>;
}

export interface ClosureResult {
	/** All modules reachable from the root, root first. */
	modules: readonly ModuleInfo[];
	/**
	 * Aggregate cache key for the closure — derived from every module's
	 * `compileKey`. Suitable as `Executor.runCached` id.
	 */
	bundleKey: string;
}

export class ModuleGraph {
	readonly #host: Host;
	readonly #opts: ModuleGraphOptions;
	readonly #inFlight = new Map<string, Promise<ModuleInfo>>();

	constructor(host: Host, opts: ModuleGraphOptions) {
		this.#host = host;
		this.#opts = opts;
	}

	/** Compile (or look up the cached compile of) a single module. */
	async compile(path: string): Promise<ModuleInfo> {
		const inFlight = this.#inFlight.get(path);
		if (inFlight) return inFlight;
		const promise = this.#compileImpl(path).finally(() => {
			this.#inFlight.delete(path);
		});
		this.#inFlight.set(path, promise);
		return promise;
	}

	async #compileImpl(path: string): Promise<ModuleInfo> {
		const sourceBytes = await this.#host.storage.read(path);
		const sourceHash = await contentId(sourceBytes);
		const compileKey = await contentIdWithConfig(sourceBytes, {
			compiler: COMPILER_VERSION,
			runtimeImport: this.#opts.runtimeImport,
			env: this.#opts.env ?? null,
		});

		let compiled: string;
		const cached = await this.#host.storage.cacheRead(compileKey);
		if (cached) {
			compiled = dec.decode(cached);
			this.#host.logger.event("module-graph.cache.hit", { path, compileKey });
		} else {
			const source = dec.decode(sourceBytes);
			compiled = await this.#compileSource(path, source);
			await this.#host.storage.cacheWrite(compileKey, enc.encode(compiled));
			this.#host.logger.event("module-graph.compile", { path, compileKey });
		}

		const resolvedImports = extractAstroImports(path, compiled);

		const node: ModuleNode = {
			path,
			hash: sourceHash,
			imports: resolvedImports,
			importedBy: [],
		};
		await this.#host.coordinator.graphPut(node);

		return { path, sourceHash, compileKey, compiled, resolvedImports };
	}

	/** Dispatch source to the right compiler based on file extension. */
	async #compileSource(path: string, source: string): Promise<string> {
		// Resolve image imports up-front: `import logo from "./logo.png"` is
		// replaced with a `const logo = {…ImageMetadata…};` literal sourced
		// from the host's `ImageService`. Runs before TS-strip so esbuild
		// sees a normal const declaration rather than an unresolved import.
		const preprocessed = await this.#substituteImageImports(path, source);
		if (path.endsWith(".md")) {
			const result = await compileMarkdown(preprocessed, {
				runtimeImport: this.#opts.runtimeImport,
				filename: path,
			});
			return result.code;
		}
		const result = await compileAstro(preprocessed, {
			runtimeImport: this.#opts.runtimeImport,
			filename: path,
			env: this.#opts.env,
		});
		if (result.errors.length > 0) {
			const first = result.errors[0];
			throw new Error(
				`compile error in ${path} at ${first?.start.line}:${first?.start.column}: ${first?.message}`,
			);
		}
		return result.code;
	}

	/**
	 * Find every `import NAME from "./path.png"`-shaped statement in the
	 * source and replace it with a const declaration whose value is the
	 * `ImageMetadata` literal returned by `host.imageService`.
	 *
	 * No-op when no image service is configured — the unresolved import
	 * survives to the bundler, which strips it (and the `<Image src=...>`
	 * call site sees `undefined`). Acceptable degraded mode for tests
	 * that don't exercise images.
	 */
	async #substituteImageImports(importerPath: string, source: string): Promise<string> {
		const service = this.#host.imageService;
		if (!service) return source;
		const matches: Array<{ start: number; end: number; replacement: string }> = [];
		const re = /^[ \t]*import[ \t]+([A-Za-z_$][\w$]*)[ \t]+from[ \t]+["']([^"']+)["'];?[ \t]*$/gm;
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
		while ((m = re.exec(source)) !== null) {
			const spec = m[2] as string;
			if (!IMAGE_EXTENSIONS.test(spec)) continue;
			const varName = m[1] as string;
			const resolved = joinPath(dirname(importerPath), spec);
			let metadata: ImageMetadata;
			try {
				metadata = await service.getMetadata(resolved);
			} catch (err) {
				this.#host.logger.event("module-graph.image-import.unresolved", {
					importer: importerPath,
					spec,
					message: (err as Error).message,
				});
				continue;
			}
			matches.push({
				start: m.index,
				end: m.index + m[0].length,
				replacement: `const ${varName} = ${JSON.stringify(metadata)};`,
			});
		}
		if (matches.length === 0) return source;
		// Apply right-to-left so earlier offsets stay valid.
		let out = source;
		for (let i = matches.length - 1; i >= 0; i--) {
			const e = matches[i] as (typeof matches)[number];
			out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
		}
		return out;
	}

	/**
	 * DFS the import closure from `rootPath`. Each path visited exactly once.
	 * Diamond imports collapse; cycles short-circuit at the second visit.
	 */
	async closure(rootPath: string): Promise<ClosureResult> {
		const visited = new Set<string>();
		const ordered: ModuleInfo[] = [];

		const walk = async (path: string): Promise<void> => {
			if (visited.has(path)) return;
			visited.add(path);
			const info = await this.compile(path);
			ordered.push(info);
			for (const dep of info.resolvedImports) {
				await walk(dep);
			}
		};

		await walk(rootPath);

		// Aggregate key: every module's path+compileKey, sorted, then content-id'd.
		const keyMaterial = ordered
			.map((m) => `${m.path}:${m.compileKey}`)
			.slice()
			.sort()
			.join("\n");
		const bundleKey = await contentId(keyMaterial);
		return { modules: ordered, bundleKey };
	}
}

/**
 * Resolve every `.astro` import in compiled ESM relative to the importer's
 * directory. Returns workspace-absolute paths.
 */
function extractAstroImports(importerPath: string, compiled: string): string[] {
	const importerDir = dirname(importerPath);
	const out: string[] = [];
	for (const spec of extractImports(compiled)) {
		if (!spec.endsWith(ASTRO_EXT)) continue;
		out.push(joinPath(importerDir, spec));
	}
	return out;
}
