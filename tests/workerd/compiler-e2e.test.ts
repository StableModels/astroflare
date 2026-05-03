/**
 * Phase 2.5d: compiler+runtime end-to-end inside real workerd.
 *
 * The Phase 2 e2e tests run in Layer A (Node) via `InProcessExecutor` plus
 * the `dist/internal.js` `file://` URL hack — the runtime resolves through
 * Node's filesystem importer. This file is the production-shaped equivalent:
 *
 *   - compile each `.astro` source, walk the import closure via Phase 4's
 *     `ModuleGraph`, inline-bundle into a single ESM file (Phase 4's
 *     `inlineBundle` lifts user imports out of the per-module IIFEs)
 *   - include the runtime's compiled JS files inside the bundle so the one
 *     remaining outer `import` resolves via workerd's native resolver
 *     (no `node_modules`, no tmp-dir, no Vite intercept)
 *   - run via `WorkerdExecutor` (real Cloudflare Worker Loader)
 *   - assert the rendered HTML
 *
 * This proves the path the brief actually specifies (§4 Worker Loader)
 * end-to-end and drops the `dist/internal.js` `file://` URL hack.
 */

import { env } from "cloudflare:test";
import type { Host, RenderResult } from "@astroflare/core";
import { WorkerdExecutor } from "@astroflare/host-cloudflare";
import { ModuleGraph, inlineBundle } from "@astroflare/preview";
// Subpath import avoids pulling InProcessExecutor (which uses node:os/fs/url
// and breaks in workerd even with nodejs_compat).
import {
	MapCoordinator,
	MemoryStorage,
	MemoryTransport,
	StubClock,
	StubLogger,
} from "@astroflare/test-utils/in-memory";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-expect-error — Vite ?raw default-exports string; type not carried.
import RUNTIME_COMPONENTS_SRC from "../../packages/astroflare-runtime/dist/components.js?raw";
// @ts-expect-error
import RUNTIME_COOKIES_SRC from "../../packages/astroflare-runtime/dist/cookies.js?raw";
// @ts-expect-error — Phase 15a: runtime/index.js re-exports env.js.
import RUNTIME_ENV_SRC from "../../packages/astroflare-runtime/dist/env.js?raw";
// @ts-expect-error — Phase 19: runtime/index.js re-exports error-overlay.
import RUNTIME_ERROR_OVERLAY_SRC from "../../packages/astroflare-runtime/dist/error-overlay.js?raw";
// @ts-expect-error
import RUNTIME_HMR_SRC from "../../packages/astroflare-runtime/dist/hmr-client.js?raw";
// @ts-expect-error — Phase 16: runtime/index.js re-exports hydration-client.
import RUNTIME_HYDRATION_SRC from "../../packages/astroflare-runtime/dist/hydration-client.js?raw";
// @ts-expect-error — Phase 18: runtime/index.js re-exports i18n.
import RUNTIME_I18N_SRC from "../../packages/astroflare-runtime/dist/i18n.js?raw";
// Vite's `?raw` plugin works inside vitest-pool-workers. The relative
// path bypasses the runtime package's `exports` map (which doesn't expose
// `dist/`). The pretest `tsc -b` step builds the dist artifacts.
// @ts-expect-error
import RUNTIME_INDEX_SRC from "../../packages/astroflare-runtime/dist/index.js?raw";
// @ts-expect-error
import RUNTIME_INTERNAL_SRC from "../../packages/astroflare-runtime/dist/internal.js?raw";
// @ts-expect-error — Phase 14: jsx-runtime is re-exported from the runtime
// index so the workerd resolver needs the file present in the module map.
import RUNTIME_JSX_RUNTIME_SRC from "../../packages/astroflare-runtime/dist/jsx-runtime.js?raw";
// @ts-expect-error — Phase 17: runtime/index.js re-exports prefetch-client.
import RUNTIME_PREFETCH_SRC from "../../packages/astroflare-runtime/dist/prefetch-client.js?raw";
// @ts-expect-error
import RUNTIME_RENDER_SRC from "../../packages/astroflare-runtime/dist/render.js?raw";
// @ts-expect-error — Phase 17: runtime/index.js re-exports rss + sitemap.
import RUNTIME_RSS_SRC from "../../packages/astroflare-runtime/dist/rss.js?raw";
// @ts-expect-error
import RUNTIME_SITEMAP_SRC from "../../packages/astroflare-runtime/dist/sitemap.js?raw";
// @ts-expect-error — Phase 17: runtime/index.js re-exports view-transitions-client.
import RUNTIME_VT_SRC from "../../packages/astroflare-runtime/dist/view-transitions-client.js?raw";

const RUNTIME_BUNDLE_MODULES: Record<string, string> = {
	"runtime/index.js": RUNTIME_INDEX_SRC as string,
	"runtime/internal.js": RUNTIME_INTERNAL_SRC as string,
	"runtime/render.js": RUNTIME_RENDER_SRC as string,
	"runtime/hmr-client.js": RUNTIME_HMR_SRC as string,
	"runtime/cookies.js": RUNTIME_COOKIES_SRC as string,
	"runtime/components.js": RUNTIME_COMPONENTS_SRC as string,
	"runtime/jsx-runtime.js": RUNTIME_JSX_RUNTIME_SRC as string,
	"runtime/env.js": RUNTIME_ENV_SRC as string,
	"runtime/hydration-client.js": RUNTIME_HYDRATION_SRC as string,
	"runtime/view-transitions-client.js": RUNTIME_VT_SRC as string,
	"runtime/prefetch-client.js": RUNTIME_PREFETCH_SRC as string,
	"runtime/rss.js": RUNTIME_RSS_SRC as string,
	"runtime/sitemap.js": RUNTIME_SITEMAP_SRC as string,
	"runtime/i18n.js": RUNTIME_I18N_SRC as string,
	"runtime/error-overlay.js": RUNTIME_ERROR_OVERLAY_SRC as string,
};

const RUNTIME_IMPORT = "./runtime/index.js";

const enc = (s: string) => new TextEncoder().encode(s);

interface RouteInput {
	url: string;
	method?: string;
	props?: Record<string, unknown>;
	params?: Record<string, string>;
}

/**
 * Build a minimal `Host` that uses the WorkerdExecutor + in-memory pieces.
 * Mirrors `createTestHost()` shape but skips InProcessExecutor (Node-only)
 * since we're spawning real isolates instead.
 */
function makeWorkerdHost(): Host {
	const clock = new StubClock();
	return {
		storage: new MemoryStorage(),
		coordinator: new MapCoordinator(),
		transport: new MemoryTransport(),
		clock,
		logger: new StubLogger(clock),
		executor: new WorkerdExecutor({
			loader: env.LOADER,
			compatibilityDate: "2025-09-01",
			compatibilityFlags: ["nodejs_compat"],
		}),
	};
}

async function renderViaWorkerd(
	files: Record<string, string>,
	rootPath: string,
	input: RouteInput,
): Promise<string> {
	const host = makeWorkerdHost();
	for (const [p, body] of Object.entries(files)) await host.storage.write(p, enc(body));

	const graph = new ModuleGraph(host, { runtimeImport: RUNTIME_IMPORT });
	const closure = await graph.closure(rootPath);
	const bundleCode = inlineBundle(closure.modules, RUNTIME_IMPORT);

	const result = await host.executor.runOnce<RenderResult>(
		{
			mainModule: "main.js",
			modules: {
				"main.js": bundleCode,
				...RUNTIME_BUNDLE_MODULES,
			},
		},
		input,
	);
	if (result.kind !== "html") {
		throw new Error(`expected html render, got ${result.kind}`);
	}
	return result.html;
}

describe("compiler+runtime end-to-end inside workerd", () => {
	it("renders a single .astro module", async () => {
		const html = await renderViaWorkerd(
			{
				"/src/pages/index.astro": "---\nconst { name } = Astro.props;\n---\n<p>{name}</p>",
			},
			"/src/pages/index.astro",
			{ url: "https://app/", props: { name: "<bob>" } },
		);
		expect(html).toBe("<p>&lt;bob&gt;</p>");
	});

	it("multi-module composition: parent imports a layout + a child", async () => {
		const html = await renderViaWorkerd(
			{
				"/src/pages/index.astro":
					"---\n" +
					'import Layout from "../components/Layout.astro";\n' +
					'import Button from "../components/Button.astro";\n' +
					"---\n" +
					'<Layout><Button label="Click" /></Layout>',
				"/src/components/Layout.astro": "<header><slot /></header>",
				"/src/components/Button.astro":
					"---\nconst { label } = Astro.props;\n---\n<button>{label}</button>",
			},
			"/src/pages/index.astro",
			{ url: "https://app/" },
		);
		expect(html).toBe("<header><button>Click</button></header>");
	});

	it("Astro.params reaches the component for [slug]-style routes", async () => {
		const html = await renderViaWorkerd(
			{
				"/src/pages/posts/[slug].astro":
					"---\nconst { slug } = Astro.params;\n---\n<p>slug={slug}</p>",
			},
			"/src/pages/posts/[slug].astro",
			{ url: "https://app/posts/hello", params: { slug: "hello" } },
		);
		expect(html).toBe("<p>slug=hello</p>");
	});
});
