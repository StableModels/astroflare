/**
 * `uploadFiles` — push a fixture's source tree into a preview
 * worker's R2-backed workspace. Counterpart to
 * `deployStaticBundle`'s pre-render path: instead of compiling +
 * rendering locally and shipping HTML, we ship the raw `.astro`
 * sources and let the preview worker compile + render on-demand.
 *
 * For each `.astro` (or other workspace) file under `<fixtureDir>`,
 * we POST it to `<previewUrl>/_aflare/file?path=<workspace-path>`.
 * The preview worker writes to R2, recomputes the file hash, and
 * publishes an HMR `update` to any subscribed clients.
 *
 * Workspace path layout matches `pathnameToSourcePath` in
 * `preview-worker.ts`: a fixture's `src/pages/index.astro` lands
 * at `/src/pages/index.astro`, and a request for `/` resolves
 * back to it.
 *
 * Bearer auth: the preview-worker's `DEPLOY_TOKEN` secret is read
 * from the persisted `PreviewState` and sent as
 * `Authorization: Bearer <token>`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PreviewState } from "../state.js";

export interface UploadFilesInput {
	preview: PreviewState;
	/** Local fixture root (the directory whose contents we ship). */
	fixtureDir: string;
	/**
	 * Subdirectories to upload. Default: `["src", "public"]` — covers
	 * page sources + static assets. Paths are relative to `fixtureDir`.
	 */
	roots?: readonly string[];
	/**
	 * Optional: file extensions to include (case-insensitive). Default
	 * `[".astro", ".ts", ".tsx", ".js", ".jsx", ".css", ".html",
	 * ".svg", ".png", ".jpg", ".jpeg", ".webp", ".json"]`.
	 */
	includeExtensions?: readonly string[];
	/** Override the `fetch` implementation (for tests). */
	fetchImpl?: typeof fetch;
}

export interface UploadedFile {
	/** Workspace path the preview worker will resolve against. */
	workspacePath: string;
	/** Number of bytes uploaded. */
	bytes: number;
	/** Content hash returned by the preview worker. */
	hash: string | null;
}

export interface UploadFilesResult {
	uploaded: readonly UploadedFile[];
	skipped: readonly string[];
}

const DEFAULT_ROOTS = ["src", "public"] as const;
const DEFAULT_EXTENSIONS = [
	".astro",
	".ts",
	".tsx",
	".js",
	".jsx",
	".css",
	".html",
	".svg",
	".png",
	".jpg",
	".jpeg",
	".webp",
	".json",
] as const;

export async function uploadFiles(input: UploadFilesInput): Promise<UploadFilesResult> {
	const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const roots = input.roots ?? DEFAULT_ROOTS;
	const exts = (input.includeExtensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase());

	const files: string[] = [];
	for (const root of roots) {
		const rootDir = join(input.fixtureDir, root);
		if (!(await pathExists(rootDir))) continue;
		for await (const file of walk(rootDir)) {
			if (exts.some((ext) => file.toLowerCase().endsWith(ext))) {
				files.push(file);
			}
		}
	}
	if (files.length === 0) {
		return { uploaded: [], skipped: [`no eligible files found under ${roots.join(", ")}`] };
	}

	const url = input.preview.url.replace(/\/$/, "");
	const uploaded: UploadedFile[] = [];

	for (const fsPath of files) {
		const rel = relative(input.fixtureDir, fsPath).split(/[\\/]/).join("/");
		const workspacePath = `/${rel}`;
		const body = await readFile(fsPath);
		const res = await fetchImpl(`${url}/_aflare/file?path=${encodeURIComponent(workspacePath)}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${input.preview.deployToken}`,
				"content-type": "application/octet-stream",
			},
			// Wrap in a Uint8Array to avoid Node's `Buffer` type
			// confusing fetch's body type.
			body: new Uint8Array(body),
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`upload-files: ${workspacePath} → ${res.status}: ${text}`);
		}
		const json = (await res.json()) as { path: string; size: number; hash: string | null };
		uploaded.push({ workspacePath: json.path, bytes: json.size, hash: json.hash });
	}

	return { uploaded, skipped: [] };
}

async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const fsPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(fsPath);
		} else if (entry.isFile()) {
			yield fsPath;
		}
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}
