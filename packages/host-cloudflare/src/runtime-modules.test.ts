/**
 * `runtimeModules` integrity test.
 *
 * Catches:
 *   - the generated map drifted from `@astroflare/runtime/dist/*.js`
 *     (someone touched the runtime but forgot to run
 *     `pnpm --filter @astroflare/host-cloudflare run regen-runtime-modules`),
 *   - the canonical `runtime/index.js` key disappeared (host integrations
 *     that pass `runtime: runtimeModules` would silently fall through to
 *     the un-runtime path),
 *   - keys aren't sorted (would cause flaky CI git-diffs even when the
 *     content is identical).
 *
 * Runs in the workerd test pool, so we can't use `node:fs` to read the
 * dist directory. Instead, we pull each dist file via Vite's `?raw`
 * loader (the same trick `tests/workerd/compiler-e2e.test.ts` uses) and
 * compare byte-for-byte against the inlined map.
 */

import { describe, expect, it } from "vitest";
import { runtimeModules } from "./runtime-modules.js";

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-expect-error
import RUNTIME_COMPONENTS_SRC from "../../runtime/dist/components.js?raw";
// @ts-expect-error
import RUNTIME_COOKIES_SRC from "../../runtime/dist/cookies.js?raw";
// @ts-expect-error
import RUNTIME_ENV_SRC from "../../runtime/dist/env.js?raw";
// @ts-expect-error
import RUNTIME_ERROR_OVERLAY_SRC from "../../runtime/dist/error-overlay.js?raw";
// @ts-expect-error
import RUNTIME_HMR_SRC from "../../runtime/dist/hmr-client.js?raw";
// @ts-expect-error
import RUNTIME_HYDRATION_SRC from "../../runtime/dist/hydration-client.js?raw";
// @ts-expect-error
import RUNTIME_I18N_SRC from "../../runtime/dist/i18n.js?raw";
// @ts-expect-error
import RUNTIME_INDEX_SRC from "../../runtime/dist/index.js?raw";
// @ts-expect-error
import RUNTIME_INTERNAL_SRC from "../../runtime/dist/internal.js?raw";
// @ts-expect-error
import RUNTIME_JSX_RUNTIME_SRC from "../../runtime/dist/jsx-runtime.js?raw";
// @ts-expect-error
import RUNTIME_PREFETCH_SRC from "../../runtime/dist/prefetch-client.js?raw";
// @ts-expect-error
import RUNTIME_REACT_ADAPTER_SRC from "../../runtime/dist/react-adapter.js?raw";
// @ts-expect-error
import RUNTIME_REACT_SSR_SRC from "../../runtime/dist/react-ssr.js?raw";
// @ts-expect-error
import RUNTIME_RENDER_SRC from "../../runtime/dist/render.js?raw";
// @ts-expect-error
import RUNTIME_RSS_SRC from "../../runtime/dist/rss.js?raw";
// @ts-expect-error
import RUNTIME_SITEMAP_SRC from "../../runtime/dist/sitemap.js?raw";
// @ts-expect-error
import RUNTIME_VT_SRC from "../../runtime/dist/view-transitions-client.js?raw";

const ON_DISK: Record<string, string> = {
	"runtime/components.js": RUNTIME_COMPONENTS_SRC as string,
	"runtime/cookies.js": RUNTIME_COOKIES_SRC as string,
	"runtime/env.js": RUNTIME_ENV_SRC as string,
	"runtime/error-overlay.js": RUNTIME_ERROR_OVERLAY_SRC as string,
	"runtime/hmr-client.js": RUNTIME_HMR_SRC as string,
	"runtime/hydration-client.js": RUNTIME_HYDRATION_SRC as string,
	"runtime/i18n.js": RUNTIME_I18N_SRC as string,
	"runtime/index.js": RUNTIME_INDEX_SRC as string,
	"runtime/internal.js": RUNTIME_INTERNAL_SRC as string,
	"runtime/jsx-runtime.js": RUNTIME_JSX_RUNTIME_SRC as string,
	"runtime/prefetch-client.js": RUNTIME_PREFETCH_SRC as string,
	"runtime/react-adapter.js": RUNTIME_REACT_ADAPTER_SRC as string,
	"runtime/react-ssr.js": RUNTIME_REACT_SSR_SRC as string,
	"runtime/render.js": RUNTIME_RENDER_SRC as string,
	"runtime/rss.js": RUNTIME_RSS_SRC as string,
	"runtime/sitemap.js": RUNTIME_SITEMAP_SRC as string,
	"runtime/view-transitions-client.js": RUNTIME_VT_SRC as string,
};

describe("runtimeModules sub-path import", () => {
	it("exports the canonical runtime/index.js entry", () => {
		expect(runtimeModules).toBeTypeOf("object");
		expect(runtimeModules["runtime/index.js"]).toBeDefined();
		expect(runtimeModules["runtime/internal.js"]).toBeDefined();
	});

	it("matches every dist file byte-for-byte", () => {
		const inlinedKeys = Object.keys(runtimeModules).sort();
		const onDiskKeys = Object.keys(ON_DISK).sort();
		expect(inlinedKeys).toEqual(onDiskKeys);

		for (const key of onDiskKeys) {
			expect(runtimeModules[key], `${key} mismatch — re-run regen-runtime-modules`).toBe(
				ON_DISK[key],
			);
		}
	});

	it("keys are alphabetically sorted (deterministic file output)", () => {
		const keys = Object.keys(runtimeModules);
		const sorted = [...keys].sort();
		expect(keys).toEqual(sorted);
	});
});
