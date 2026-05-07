/**
 * Node-runtime `buildSite` tests — `continueOnError` parity with the
 * workers-runtime entry. The Node version mirrors the same flag so
 * local CLI / CI build loops can collect every per-page failure in
 * one pass.
 *
 * Default-mode behaviour (throw-on-first-error) is exercised
 * indirectly by the existing `deploy-static` integration tests; the
 * cases here focus on the new diagnostic-mode shape.
 */

import type { BuildSiteOutput, SnapshotEntry, SnapshotError } from "@astroflare/core";
import { MemorySite } from "@astroflare/test-utils";
import { describe, expect, it } from "vitest";
import { buildSite } from "./build-site.js";

const enc = (s: string) => new TextEncoder().encode(s);

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of iter) out.push(x);
	return out;
}

describe("buildSite (node) — continueOnError", () => {
	it("yields a SnapshotError for compile failures and keeps iterating", async () => {
		const site = new MemorySite();
		site.write("/src/pages/good.astro", enc("---\n---\n<h1>good</h1>"));
		site.write("/src/pages/bad-compile.astro", enc("<p>{unclosed"));

		const out: BuildSiteOutput[] = await collect(buildSite({ site, continueOnError: true }));

		const entries = out.filter((x): x is SnapshotEntry => "bytes" in x);
		const errors = out.filter(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);

		expect(entries.map((e) => e.route).sort()).toEqual(["/good"]);
		expect(errors).toHaveLength(1);
		const err = errors[0];
		if (!err) throw new Error("expected one error");
		expect(err.sourcePath).toBe("/src/pages/bad-compile.astro");
		expect(err.phase).toBe("compile");
		expect(err.message).toMatch(/compile failed for \/src\/pages\/bad-compile\.astro/);
	});

	it("yields a SnapshotError for unsupported dynamic routes", async () => {
		const site = new MemorySite();
		site.write("/src/pages/posts/[slug].astro", enc("---\n---\n<h1>x</h1>"));

		const out = await collect(buildSite({ site, continueOnError: true }));

		expect(out).toHaveLength(1);
		const err = out[0] as SnapshotError;
		expect(err.kind).toBe("error");
		expect(err.sourcePath).toBe("/src/pages/posts/[slug].astro");
		expect(err.phase).toBe("getStaticPaths");
		expect(err.message).toMatch(/dynamic routes.*not yet supported/);
	});

	it("throws on first error when continueOnError is unset (default)", async () => {
		const site = new MemorySite();
		site.write("/src/pages/good.astro", enc("---\n---\n<h1>good</h1>"));
		site.write("/src/pages/bad-compile.astro", enc("<p>{unclosed"));

		await expect(collect(buildSite({ site }))).rejects.toThrow(
			/compile failed for \/src\/pages\/bad-compile\.astro/,
		);
	});
});
