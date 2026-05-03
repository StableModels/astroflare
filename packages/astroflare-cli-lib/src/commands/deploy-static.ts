/**
 * `deployStaticBundle` — compile + render one or more fixture
 * source trees locally, upload all rendered HTML as a single
 * atomic deploy, and flip the stack's `/site/current` pointer.
 *
 * Used by the e2e test suite to deploy real Astroflare fixtures
 * onto a Phase-21 stack without the stack worker needing the
 * compiler chain in its bundle. The framework's compile + render
 * code runs in the test process (Node) — same code that runs in
 * unit tests; the rendered output is what Cloudflare serves.
 *
 * What this exercises:
 *   - The framework's compile pipeline (`compileAstro`)
 *   - The runtime's `render()`
 *   - The stack worker's R2 read + serve path
 *   - The artifact layout the stack worker expects
 *     (`files/site/<deployHash>/<route>.html`, `files/site/current`)
 *
 * What this doesn't yet exercise (Phase 22b):
 *   - Live SSR (output: "server" routes)
 *   - The deploy ceremony running inside Cloudflare
 *   - Workflow-orchestrated parallel render fan-out
 *
 * Multiple fixtures get merged into one deploy so they can all
 * serve from the same stack URL simultaneously — each fixture's
 * routes get prefixed with `/<fixtureName>/`. One atomic flip
 * means specs see either the old deploy (if any) or the full new
 * set, never a partial state.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { CloudflareClient } from "../api.js";
import type { StackState } from "../state.js";

const require_ = createRequire(import.meta.url);

export interface FixtureSource {
	/** Routes will mount under `/<name>/...`; root index becomes `/<name>/`. */
	name: string;
	/** Local fixture root (the directory containing `src/pages/`). */
	dir: string;
}

export interface DeployStaticInput {
	stack: StackState;
	client: CloudflareClient;
	fixtures: readonly FixtureSource[];
}

export interface DeployedRoute {
	fixture: string;
	route: string;
	objectKey: string;
	bytes: number;
}

export interface DeployStaticResult {
	deployHash: string;
	routes: readonly DeployedRoute[];
}

const FILES_PREFIX = "files/";
const SITE_PREFIX = "site";

/**
 * Static-only multi-fixture deploy: walks each fixture's
 * `src/pages/` for `.astro` routes, compiles + renders each,
 * collects everything into a single deploy, uploads, flips
 * `/site/current`. The deploy hash is content-addressed over the
 * sorted set of (route, html) pairs across all fixtures.
 */
export async function deployStaticBundle(input: DeployStaticInput): Promise<DeployStaticResult> {
	if (input.fixtures.length === 0) {
		throw new Error("deployStaticBundle: no fixtures supplied");
	}

	const tmp = await mkdtemp(join(tmpdir(), "aflare-deploy-"));
	try {
		const rendered: { fixture: string; route: string; html: string }[] = [];

		for (const fixture of input.fixtures) {
			const pagesDir = join(fixture.dir, "src", "pages");
			if (!(await pathExists(pagesDir))) {
				throw new Error(`fixture has no src/pages directory: ${pagesDir}`);
			}
			const pages = await collectAstroPages(pagesDir);
			if (pages.length === 0) {
				throw new Error(`fixture has no .astro pages under ${pagesDir}`);
			}
			for (const page of pages) {
				const localRoute = pageRoute(page.relPath);
				const route = prefixRoute(fixture.name, localRoute);
				const html = await compileAndRender(page.fsPath, route, tmp);
				rendered.push({ fixture: fixture.name, route, html });
			}
		}

		// Content-addressed deploy hash — same input → same output.
		// Sort for stability (cross-fixture, cross-route).
		rendered.sort((a, b) => a.route.localeCompare(b.route));
		const fingerprint = rendered.map((r) => `${r.route}\0${r.html}`).join("\n");
		const deployHash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);

		const routes: DeployedRoute[] = [];
		for (const { fixture, route, html } of rendered) {
			const outputPath = routeToOutputPath(route);
			const objectKey = `${FILES_PREFIX}${SITE_PREFIX}/${deployHash}${outputPath}`;
			await input.client.putR2Object({
				bucket: input.stack.bucketName,
				key: objectKey,
				body: html,
				contentType: "text/html;charset=utf-8",
			});
			routes.push({ fixture, route, objectKey, bytes: html.length });
		}

		// Flip `/site/current` last so reads either see the previous
		// deploy or the new one (consistent), never a half-written
		// intermediate.
		await input.client.putR2Object({
			bucket: input.stack.bucketName,
			key: `${FILES_PREFIX}${SITE_PREFIX}/current`,
			body: deployHash,
			contentType: "text/plain;charset=utf-8",
		});

		return { deployHash, routes };
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

interface AstroPage {
	relPath: string;
	fsPath: string;
}

async function collectAstroPages(pagesDir: string): Promise<AstroPage[]> {
	const out: AstroPage[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const fsPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fsPath);
			} else if (entry.isFile() && entry.name.endsWith(".astro")) {
				const relPath = relative(pagesDir, fsPath).split(/[\\/]/).join("/");
				out.push({ relPath, fsPath });
			}
		}
	}
	await walk(pagesDir);
	return out;
}

/** Map a fixture page like `index.astro` to `/`, `about.astro` to `/about`. */
function pageRoute(relPath: string): string {
	const noExt = relPath.replace(/\.astro$/, "");
	if (/\[[^\]]+\]/.test(noExt)) {
		throw new Error(
			`dynamic routes (${relPath}) need getStaticPaths to enumerate; not supported in deployStaticBundle yet`,
		);
	}
	if (noExt === "index") return "/";
	if (noExt.endsWith("/index")) return `/${noExt.slice(0, -"/index".length)}`;
	return `/${noExt}`;
}

function prefixRoute(fixture: string, localRoute: string): string {
	if (localRoute === "/") return `/${fixture}/`;
	return `/${fixture}${localRoute}`;
}

function routeToOutputPath(route: string): string {
	if (route.endsWith("/")) return `${route}index.html`;
	return `${route}/index.html`;
}

/**
 * Compile + render a single `.astro` file, returning HTML.
 * Uses the framework's local compiler + runtime — same code that
 * runs in unit tests.
 */
async function compileAndRender(fsPath: string, route: string, tmpDir: string): Promise<string> {
	const { compileAstro } = await import("@astroflare/compiler/astro");
	const { render } = await import("@astroflare/runtime");

	// The compiled module imports framework runtime symbols from
	// `runtimeImport`; point that at the absolute file:// URL of the
	// runtime's built `internal.js` so Node can resolve the import
	// from the tmp dir we write the compiled code to.
	const runtimeImport = pathToFileURL(require_.resolve("@astroflare/runtime/internal")).href;

	const source = await readFile(fsPath, "utf8");
	const compiled = await compileAstro(source, {
		filename: fsPath,
		runtimeImport,
	});
	// Compiled output references the runtime via `@astroflare/runtime/internal`.
	// Write to a uniquely-named tmp file so dynamic-import gets a fresh module
	// record per call.
	const moduleName = `aflare-${createHash("sha256")
		.update(source + route)
		.digest("hex")
		.slice(0, 16)}.mjs`;
	const modulePath = join(tmpDir, moduleName);
	await mkdir(dirname(modulePath), { recursive: true });
	await writeFile(modulePath, compiled.code, "utf8");
	const moduleUrl = pathToFileURL(modulePath).href;

	const mod = (await import(/* @vite-ignore */ moduleUrl)) as { default: unknown };

	const result = await render(mod.default as never, {
		props: {},
		params: {},
		request: new Request(`http://stack.local${route}`),
		url: new URL(`http://stack.local${route}`),
	});

	if (result.kind === "html") return result.html;
	throw new Error(
		`fixture ${posix.basename(fsPath)} returned non-HTML render result (kind=${result.kind})`,
	);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}
