/**
 * Static render fan-out.
 *
 * For each prerenderable route in the build plan, compile its closure,
 * build a TaskBundle, run via `host.executor.runOnce` (no shared cache
 * across builds for now), capture the HTML, write to the deploy
 * artifact under `/site/<deployHash>/<outputPath>`.
 *
 * Phase 7 carve-outs (in retro):
 *   - Sequential per-route. Real Cloudflare deploys use a Workflow with
 *     up to 10k step parallelism (§4 / §7.7). The framework's contract
 *     here is "render this route, write the HTML"; the host's deploy
 *     orchestration can swap `runForRoutes` for a parallel implementation
 *     without touching the framework.
 *   - No client-island bundling (Phase 8 territory).
 *   - No source-map output, no manifest hashing of route bodies — those
 *     pieces ride along when needed.
 */

import type { Host, RenderContext, Storage } from "@astroflare/core";
import { ModuleGraph, inlineBundle } from "@astroflare/preview";
import type { RoutePlan } from "./planner.js";

export interface RenderFanoutOptions {
	host: Host;
	deployHash: string;
	siteRoot?: string;
	runtimeImport: string;
}

export interface RoutePlannedHtml {
	route: RoutePlan;
	html: string;
	storagePath: string;
}

const enc = new TextEncoder();

/**
 * Render every static route in `plans`, write each to
 * `${siteRoot}/${deployHash}/${plan.outputPath}`. Returns the list of
 * rendered routes for callers that want to assemble a manifest.
 */
export async function renderForRoutes(
	plans: readonly RoutePlan[],
	opts: RenderFanoutOptions,
): Promise<RoutePlannedHtml[]> {
	const siteRoot = opts.siteRoot ?? "/site";
	const moduleGraph = new ModuleGraph(opts.host, { runtimeImport: opts.runtimeImport });
	const out: RoutePlannedHtml[] = [];

	for (const plan of plans) {
		if (plan.kind !== "static") continue;
		const closure = await moduleGraph.closure(plan.route.filePath);
		const code = inlineBundle(closure.modules, opts.runtimeImport);

		const url = new URL(deployUrlFor(plan.outputPath), "https://deploy.local/");
		const request = new Request(url);
		const ctx: RenderContext = {
			props: {},
			params: {},
			request,
			url,
		};

		const html = await opts.host.executor.runOnce<string>(
			{ mainModule: "main.js", modules: { "main.js": code } },
			ctx,
		);

		const storagePath = `${siteRoot}/${opts.deployHash}/${plan.outputPath}`;
		await opts.host.storage.write(storagePath, enc.encode(html));
		out.push({ route: plan, html, storagePath });
	}

	return out;
}

/**
 * Convert a deploy artifact path back into a request URL pathname so the
 * compiled module's `Astro.url` looks right when the build executes it.
 *   `index.html`             → `/`
 *   `about/index.html`       → `/about`
 *   `posts/hello/index.html` → `/posts/hello`
 */
export function deployUrlFor(outputPath: string): string {
	if (outputPath === "index.html") return "/";
	if (outputPath.endsWith("/index.html")) {
		return `/${outputPath.slice(0, -"/index.html".length)}`;
	}
	return `/${outputPath}`;
}

/**
 * Atomic flip: write `${siteRoot}/current` to point at a deploy hash.
 * Production hosts may use a content-addressed pointer or a DO with a
 * single piece of state; for the in-memory test storage we just write a
 * tiny manifest file.
 */
export async function flipCurrent(
	storage: Storage,
	deployHash: string,
	siteRoot = "/site",
): Promise<void> {
	await storage.write(`${siteRoot}/current`, enc.encode(deployHash));
}
