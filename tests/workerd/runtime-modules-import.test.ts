/**
 * Smoke test for the `@astroflare/host-cloudflare/runtime-modules`
 * sub-path import.
 *
 * Confirms:
 *   - the import resolves and yields a non-empty `Record<string, string>`
 *   - passing it directly into `createWorkerdExecutor({ runtime })` and
 *     running a tiny render through `buildSite` produces real HTML —
 *     i.e. the inlined runtime is wire-compatible with the spawned
 *     compile/render isolate's `import { render } from "./runtime/index.js"`
 *
 * This is the "host integration test" the deliverable asks for: a
 * fixture that imports the map, builds, and successfully renders.
 */

import { env } from "cloudflare:test";
import { buildSite } from "@astroflare/build";
import type { SnapshotEntry } from "@astroflare/core";
import { createWorkerdExecutor } from "@astroflare/host-cloudflare";
import { runtimeModules } from "@astroflare/host-cloudflare/runtime-modules";
import { MemorySite } from "@astroflare/test-utils/in-memory";
import { describe, expect, it } from "vitest";

const enc = (s: string) => new TextEncoder().encode(s);

describe("@astroflare/host-cloudflare/runtime-modules", () => {
	it("exposes a non-empty runtime modules map", () => {
		expect(typeof runtimeModules).toBe("object");
		const keys = Object.keys(runtimeModules);
		expect(keys.length).toBeGreaterThan(0);
		expect(runtimeModules["runtime/index.js"]).toBeDefined();
		expect(runtimeModules["runtime/internal.js"]).toBeDefined();
	});

	it("works as the runtime for createWorkerdExecutor in a real buildSite render", async () => {
		const site = new MemorySite();
		site.write(
			"/src/pages/index.astro",
			enc('---\nconst greeting = "imported runtime";\n---\n<h1>{greeting}</h1>'),
		);

		const executor = createWorkerdExecutor({
			loader: env.LOADER,
			compatibilityDate: "2025-09-01",
			compatibilityFlags: ["nodejs_compat"],
			runtime: runtimeModules,
		});

		const entries: SnapshotEntry[] = [];
		for await (const entry of buildSite({ site, executor })) {
			entries.push(entry);
		}

		expect(entries).toHaveLength(1);
		const first = entries[0];
		if (!first) throw new Error("expected one entry");
		const html = new TextDecoder().decode(first.bytes);
		expect(html).toContain("imported runtime");
	});
});
