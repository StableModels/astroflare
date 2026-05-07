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

	it("populates structured location/snippet/codeFrame/diagnostics for compile failures", async () => {
		const site = new MemorySite();
		// Source: line 1 `---`, line 2 `---`, line 3 `<h1>{unclosed` (EOF).
		// Acorn runs off the end → parser reports "Unclosed expression
		// (missing `}`)" pinned at the opening `{` on line 3, column 5.
		site.write("/src/pages/bad-compile.astro", enc(["---", "---", "<h1>{unclosed"].join("\n")));

		const out = await collect(buildSite({ site, continueOnError: true }));
		const errors = out.filter(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);
		expect(errors).toHaveLength(1);
		const err = errors[0];
		if (!err) throw new Error("expected one error");

		// Structured location: the `{` on line 3, column 5 (offset 12).
		expect(err.location).toBeDefined();
		expect(err.location?.line).toBe(3);
		expect(err.location?.column).toBe(5);
		expect(err.location?.offset).toBe(12);

		// Detail is the raw parser message, not the framework's prefix.
		expect(err.detail).toMatch(/Unclosed expression/i);

		// Code frame is multi-line and includes a caret on the highlight line.
		expect(err.codeFrame).toBeDefined();
		expect(err.codeFrame?.highlightLine).toBe(3);
		expect(err.codeFrame?.text).toContain("<h1>{unclosed");
		expect(err.codeFrame?.text).toMatch(/\^/);

		// Diagnostics array includes the same primary entry (and any siblings
		// the parser flagged on the same pass).
		expect(err.diagnostics).toBeDefined();
		expect((err.diagnostics ?? []).length).toBeGreaterThanOrEqual(1);
		expect(err.diagnostics?.[0].location.line).toBe(3);
	});

	it("forwards the underlying stack on render failures so consumers can trace user code", async () => {
		const site = new MemorySite();
		site.write(
			"/src/pages/bad-render.astro",
			enc(["---", 'throw new Error("render boom");', "---", "<h1>x</h1>"].join("\n")),
		);
		const out = await collect(buildSite({ site, continueOnError: true }));
		const err = out.find(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);
		if (!err) throw new Error("expected a render error");
		expect(err.phase).toBe("render");
		expect(err.detail).toMatch(/render boom/);
		expect(err.stack).toBeDefined();
		expect(err.stack).toContain("render boom");
	});
});
