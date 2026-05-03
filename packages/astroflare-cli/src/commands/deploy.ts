/**
 * `aflare deploy` / `aflare status` / `aflare rollback` — programmatic
 * implementations behind the CLI subcommands.
 *
 * Pipeline for `deploy`:
 *
 *   1. Walk the project's `src/` and `public/` directories on disk.
 *   2. Hash each file's content (SHA-256). Compare against R2 via HEAD;
 *      skip uploads whose hash already matches.
 *   3. Upload changed files to R2 via the Cloudflare REST API
 *      (`/accounts/<id>/r2/buckets/<bucket>/objects/<key>`). Object
 *      key prefixing matches `R2Storage`'s layout: `files/<workspace-path>`.
 *   4. POST `/_aflare/deploy` on the project worker with the deploy
 *      token. The worker runs the planner + render fan-out + manifest
 *      write + atomic flip.
 *
 * Status pulls the active deploy hash from `/_aflare/deploy/status`.
 *
 * Rollback writes a new `/site/current` pointer directly via R2 API —
 * no re-rendering, no executor spin-up, just a pointer flip.
 *
 * No third-party deps: only Node stdlib (`fs/promises`, `path`, `crypto`,
 * `fetch`). Keeps the install fast and the supply chain narrow.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const FILES_PREFIX = "files/";
const HASH_META_KEY = "aflare-sha";
const DEFAULT_INCLUDE = ["src", "public"] as const;

export interface DeployConfig {
	/** Cloudflare account ID. */
	accountId: string;
	/** R2 bucket name. */
	bucket: string;
	/** Cloudflare API token with R2 write scope. */
	apiToken: string;
	/** Project worker URL, e.g. `https://my-site.workers.dev`. */
	url: string;
	/** Bearer token matching the worker's `env.DEPLOY_TOKEN`. */
	deployToken: string;
	/** Local project root (the directory containing `src/`). */
	projectDir: string;
}

export interface ResolveConfigInput {
	flags: Partial<{
		accountId: string;
		bucket: string;
		apiToken: string;
		url: string;
		deployToken: string;
		projectDir: string;
	}>;
	env: NodeJS.ProcessEnv;
}

/**
 * Resolve a `DeployConfig` from CLI flags, environment variables, and an
 * optional `aflare.config.json` in the project root. Flags take priority
 * over env, which takes priority over the config file.
 */
export async function resolveConfig(input: ResolveConfigInput): Promise<DeployConfig> {
	const projectDir = input.flags.projectDir ?? input.env.AFLARE_PROJECT_DIR ?? ".";
	const fileCfg = await readConfigFile(projectDir);

	const accountId =
		input.flags.accountId ?? input.env.CLOUDFLARE_ACCOUNT_ID ?? fileCfg.accountId;
	const bucket = input.flags.bucket ?? input.env.AFLARE_BUCKET ?? fileCfg.bucket;
	const apiToken =
		input.flags.apiToken ?? input.env.CLOUDFLARE_API_TOKEN ?? fileCfg.apiToken;
	const url = input.flags.url ?? input.env.AFLARE_WORKER_URL ?? fileCfg.url;
	const deployToken =
		input.flags.deployToken ?? input.env.DEPLOY_TOKEN ?? fileCfg.deployToken;

	const missing: string[] = [];
	if (!accountId) missing.push("accountId (CLOUDFLARE_ACCOUNT_ID)");
	if (!bucket) missing.push("bucket (AFLARE_BUCKET)");
	if (!apiToken) missing.push("apiToken (CLOUDFLARE_API_TOKEN)");
	if (!url) missing.push("url (AFLARE_WORKER_URL)");
	if (!deployToken) missing.push("deployToken (DEPLOY_TOKEN)");
	if (missing.length > 0) {
		throw new Error(
			`aflare: missing config — ${missing.join(", ")}. Set via flag, env var, or aflare.config.json.`,
		);
	}

	return {
		accountId: accountId as string,
		bucket: bucket as string,
		apiToken: apiToken as string,
		url: (url as string).replace(/\/$/, ""),
		deployToken: deployToken as string,
		projectDir,
	};
}

async function readConfigFile(projectDir: string): Promise<Partial<DeployConfig>> {
	try {
		const raw = await fs.readFile(join(projectDir, "aflare.config.json"), "utf8");
		return JSON.parse(raw) as Partial<DeployConfig>;
	} catch {
		return {};
	}
}

export interface DeployResult {
	uploaded: string[];
	skipped: string[];
	deployHash: string;
	routeCount: number;
	skippedCount: number;
	durationMs: number;
}

export interface ProjectFile {
	/** Workspace-style path with leading slash, e.g. `/src/pages/index.astro`. */
	path: string;
	/** Local filesystem path. */
	fsPath: string;
	/** SHA-256 hash of the file contents (hex). */
	hash: string;
	/** Byte length of the file. */
	size: number;
}

/**
 * Walk the project's `src/` and `public/` directories. Returns workspace-
 * style paths suitable for R2Storage's key layout. Hidden files
 * (dot-prefixed) are skipped.
 */
export async function walkProjectFiles(projectDir: string): Promise<ProjectFile[]> {
	const out: ProjectFile[] = [];
	for (const top of DEFAULT_INCLUDE) {
		const root = join(projectDir, top);
		try {
			const stat = await fs.stat(root);
			if (!stat.isDirectory()) continue;
		} catch {
			continue;
		}
		await walkDir(root, projectDir, out);
	}
	return out;
}

async function walkDir(
	dir: string,
	projectRoot: string,
	out: ProjectFile[],
): Promise<void> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const fsPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkDir(fsPath, projectRoot, out);
			continue;
		}
		if (!entry.isFile()) continue;
		const bytes = await fs.readFile(fsPath);
		const hash = createHash("sha256").update(bytes).digest("hex");
		const rel = relative(projectRoot, fsPath).split(sep).join(posix.sep);
		out.push({
			path: `/${rel}`,
			fsPath,
			hash,
			size: bytes.length,
		});
	}
}

/**
 * Upload (or skip) every file in `files` against the R2 bucket. Returns
 * separate lists so callers can report what changed.
 */
export async function uploadFiles(
	cfg: DeployConfig,
	files: readonly ProjectFile[],
	log: (msg: string) => void = () => {},
): Promise<{ uploaded: string[]; skipped: string[] }> {
	const uploaded: string[] = [];
	const skipped: string[] = [];

	for (const file of files) {
		const key = `${FILES_PREFIX}${file.path.startsWith("/") ? file.path.slice(1) : file.path}`;

		const existingHash = await headObject(cfg, key);
		if (existingHash === file.hash) {
			skipped.push(file.path);
			continue;
		}

		const bytes = await fs.readFile(file.fsPath);
		await putObject(cfg, key, bytes, file.hash);
		uploaded.push(file.path);
		log(`uploaded ${file.path}`);
	}

	return { uploaded, skipped };
}

async function headObject(cfg: DeployConfig, key: string): Promise<string | null> {
	const url = objectUrl(cfg, key);
	const res = await fetch(url, {
		method: "HEAD",
		headers: { authorization: `Bearer ${cfg.apiToken}` },
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`R2 HEAD ${key}: ${res.status} ${res.statusText}`);
	const meta = res.headers.get("x-amz-meta-aflare-sha") ?? res.headers.get(`x-amz-meta-${HASH_META_KEY}`);
	return meta ?? null;
}

async function putObject(
	cfg: DeployConfig,
	key: string,
	bytes: Uint8Array,
	hash: string,
): Promise<void> {
	const url = objectUrl(cfg, key);
	// Copy into a fresh ArrayBuffer — the input Uint8Array's underlying
	// buffer type may be ArrayBufferLike (which includes SharedArrayBuffer)
	// and undici's `fetch` doesn't accept that as a BodyInit.
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const res = await fetch(url, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${cfg.apiToken}`,
			"content-type": "application/octet-stream",
			[`x-amz-meta-${HASH_META_KEY}`]: hash,
		},
		body: copy,
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`R2 PUT ${key}: ${res.status} ${res.statusText}: ${body}`);
	}
}

function objectUrl(cfg: DeployConfig, key: string): string {
	return `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/r2/buckets/${cfg.bucket}/objects/${encodeURI(key)}`;
}

/** POST `/_aflare/deploy` on the project worker. Returns the response JSON. */
export async function triggerDeploy(cfg: DeployConfig): Promise<{
	deployHash: string;
	routeCount: number;
	skippedCount: number;
	durationMs: number;
}> {
	const res = await fetch(`${cfg.url}/_aflare/deploy`, {
		method: "POST",
		headers: { authorization: `Bearer ${cfg.deployToken}` },
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`POST /_aflare/deploy: ${res.status}: ${body}`);
	}
	return res.json() as Promise<{
		deployHash: string;
		routeCount: number;
		skippedCount: number;
		durationMs: number;
	}>;
}

/** GET `/_aflare/deploy/status`. */
export async function getStatus(cfg: DeployConfig): Promise<{
	deployHash: string | null;
	active: boolean;
}> {
	const res = await fetch(`${cfg.url}/_aflare/deploy/status`);
	if (!res.ok) {
		throw new Error(`GET /_aflare/deploy/status: ${res.status}`);
	}
	return res.json() as Promise<{ deployHash: string | null; active: boolean }>;
}

// ---------------------------------------------------------------------------
// Top-level command handlers — one per subcommand.
// ---------------------------------------------------------------------------

export async function cmdDeploy(
	cfg: DeployConfig,
	log: (msg: string) => void = () => {},
): Promise<DeployResult> {
	log(`scanning ${cfg.projectDir}…`);
	const files = await walkProjectFiles(cfg.projectDir);
	log(`${files.length} files found`);

	const { uploaded, skipped } = await uploadFiles(cfg, files, log);
	log(`${uploaded.length} uploaded, ${skipped.length} skipped`);

	log(`triggering deploy at ${cfg.url}…`);
	const deployRes = await triggerDeploy(cfg);
	log(
		`deploy ${deployRes.deployHash} — ${deployRes.routeCount} rendered, ${deployRes.skippedCount} skipped, ${deployRes.durationMs}ms`,
	);

	return {
		uploaded,
		skipped,
		deployHash: deployRes.deployHash,
		routeCount: deployRes.routeCount,
		skippedCount: deployRes.skippedCount,
		durationMs: deployRes.durationMs,
	};
}

export async function cmdStatus(cfg: DeployConfig): Promise<{
	deployHash: string | null;
	active: boolean;
}> {
	return getStatus(cfg);
}

export async function cmdRollback(
	cfg: DeployConfig,
	hash: string,
): Promise<{ deployHash: string }> {
	// Pointer-flip via R2 API. Body is the deploy hash bytes — matches
	// what `flipCurrent` writes server-side.
	const key = `${FILES_PREFIX}site/current`;
	const url = objectUrl(cfg, key);
	const res = await fetch(url, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${cfg.apiToken}`,
			"content-type": "application/octet-stream",
		},
		body: hash, // hash is a string; fetch encodes as UTF-8.
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`R2 PUT ${key}: ${res.status}: ${body}`);
	}
	return { deployHash: hash };
}
