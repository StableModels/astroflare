/**
 * In-process `Executor`.
 *
 * Per the brief: "evaluate into a fresh `MessageChannel` peer in tests" — but
 * what tests actually need is a *fresh module record* per call (not isolate-
 * level isolation). We get that cheaply by writing the bundle to a temp
 * directory and `import()`-ing the main module by `file://` URL: each unique
 * URL produces a unique module record.
 *
 *   - `runOnce` uses a unique tmp dir per call (random suffix), so module
 *     records never collide.
 *   - `runCached(id)` uses a tmp dir keyed by `id` and memoises the import
 *     promise — same id never re-installs or re-evaluates. Different id =
 *     different dir = different module record.
 *
 * The bundle's `mainModule` is a key into `modules`. Its default export must
 * be a function `(input) => unknown`. Throw if the export shape is wrong so
 * tests fail loud instead of silently returning `undefined`.
 *
 * Tmp dirs accumulate under `os.tmpdir()/astroflare-tests/<pid>`; `dispose()`
 * cleans them up.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Executor, TaskBundle } from "@astroflare/core";

interface LoadedTask {
	default: (input: unknown) => unknown;
}

export interface InProcessExecutorOptions {
	/** Override tmp root (default: `os.tmpdir()/astroflare-tests/<pid>`). */
	tmpRoot?: string;
}

export class InProcessExecutor implements Executor {
	readonly #cache = new Map<string, Promise<LoadedTask>>();
	readonly #installedDirs = new Set<string>();
	readonly #tmpRoot: string;
	#runOnceCounter = 0;

	constructor(options: InProcessExecutorOptions = {}) {
		this.#tmpRoot = options.tmpRoot ?? join(tmpdir(), "astroflare-tests", String(process.pid));
	}

	async runOnce<R>(task: TaskBundle, input: unknown): Promise<R> {
		const dir = await this.#freshDir(`once-${this.#runOnceCounter++}`);
		const mod = await this.#install(dir, task);
		return (await mod.default(input)) as R;
	}

	async runCached<R>(id: string, taskFactory: () => TaskBundle, input: unknown): Promise<R> {
		let modPromise = this.#cache.get(id);
		if (!modPromise) {
			modPromise = (async () => {
				const dir = await this.#fixedDir(id);
				const task = taskFactory();
				return this.#install(dir, task);
			})();
			this.#cache.set(id, modPromise);
		}
		const mod = await modPromise;
		return (await mod.default(input)) as R;
	}

	/** Best-effort cleanup of all tmp dirs we created. Idempotent. */
	async dispose(): Promise<void> {
		const dirs = Array.from(this.#installedDirs);
		this.#installedDirs.clear();
		this.#cache.clear();
		await Promise.all(
			dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)),
		);
	}

	async #freshDir(prefix: string): Promise<string> {
		await mkdir(this.#tmpRoot, { recursive: true });
		const dir = await mkdtemp(join(this.#tmpRoot, `${prefix}-`));
		this.#installedDirs.add(dir);
		return dir;
	}

	async #fixedDir(id: string): Promise<string> {
		// Sanitise: id may contain `/` from content hashes etc.
		const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
		const dir = join(this.#tmpRoot, "cached", safe);
		await mkdir(dir, { recursive: true });
		this.#installedDirs.add(dir);
		return dir;
	}

	async #install(dir: string, task: TaskBundle): Promise<LoadedTask> {
		// Force ESM for this directory regardless of file extensions.
		const pkgPath = join(dir, "package.json");
		if (!task.modules["package.json"]) {
			await writeFile(pkgPath, '{"type":"module"}');
		}
		for (const [key, source] of Object.entries(task.modules)) {
			const filePath = join(dir, key);
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, source);
		}
		const mainPath = join(dir, task.mainModule);
		const mainUrl = pathToFileURL(mainPath).href;
		const mod = (await import(mainUrl)) as Partial<LoadedTask>;
		if (typeof mod.default !== "function") {
			throw new Error(
				`InProcessExecutor: task ${task.mainModule} must export default function (got ${typeof mod.default})`,
			);
		}
		return mod as LoadedTask;
	}
}
