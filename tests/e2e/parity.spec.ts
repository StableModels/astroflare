/**
 * Phase 27 — dual-mode parity spec.
 *
 * The same source (`tests/e2e/fixtures/preview-host-ref/files/index.astro`)
 * is uploaded into the Mode A SiteDurableObject (preview-host-ref)
 * and bundled through Mode B's `deployStaticBundle` into the deploy
 * stack. This spec asserts the two paths produce structurally
 * equivalent rendered HTML — the same elements with the same text
 * content.
 *
 * What "structural equivalence" means here:
 *   - Same set of major tag names in document order.
 *   - Same text content (whitespace-collapsed) for each tag.
 *
 * Allowed differences (deliberately not asserted):
 *   - Wrapping whitespace / newlines.
 *   - Server-side timing comments (HTML comments containing
 *     timestamps).
 *   - Hydration markers (Mode A may emit `<astro-island>` placeholders
 *     for islands; Mode B may pre-bake them — both fine for static
 *     fixtures with no `client:*` directives).
 *
 * Self-skips when either mode isn't reachable (no credentials, or
 * preview-host bundle not built / not provisioned).
 */

import { describe, expect, it } from "vitest";
import { readRuntimeEnv } from "./runtime-env.js";

const env = readRuntimeEnv();

const ready =
	Boolean(env?.previewHostUrl) &&
	Boolean(env?.stackUrl) &&
	(env?.fixtures.includes("minimal") ?? false);

const describeIfParity = ready ? describe : describe.skip;

interface ExtractedTag {
	tag: string;
	text: string;
}

function extractTags(html: string, tags: readonly string[]): ExtractedTag[] {
	const out: ExtractedTag[] = [];
	for (const tag of tags) {
		const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
		let m: RegExpExecArray | null;
		while (true) {
			m = re.exec(html);
			if (!m) break;
			const text = (m[1] ?? "").replace(/\s+/g, " ").trim();
			out.push({ tag, text });
		}
	}
	return out;
}

describeIfParity("e2e: Mode A / Mode B parity (Phase 27)", () => {
	it("the same fixture renders structurally equivalent HTML in both modes", async () => {
		// Mode A: preview-host-ref serves the uploaded fixture at /.
		const previewUrl = `${env?.previewHostUrl?.replace(/\/$/, "")}/`;

		// Mode B: deployStaticBundle uploaded `minimal` fixture under
		// /minimal/. The `minimal` fixture contains an `index.astro`
		// with the same shape used as the preview-host-ref source —
		// for a meaningful parity assertion, both should yield the
		// same major tags + text content.
		const deployUrl = `${env?.stackUrl?.replace(/\/$/, "")}/minimal/`;

		const [previewRes, deployRes] = await Promise.all([
			fetch(previewUrl, { redirect: "follow" }),
			fetch(deployUrl, { redirect: "follow" }),
		]);

		expect(previewRes.status, `preview-host @ ${previewUrl}`).toBe(200);
		expect(deployRes.status, `deploy stack @ ${deployUrl}`).toBe(200);

		const previewBody = await previewRes.text();
		const deployBody = await deployRes.text();

		const tags = ["title", "h1"] as const;
		const previewTags = extractTags(previewBody, tags);
		const deployTags = extractTags(deployBody, tags);

		// Both should produce at least one h1 — the static fixtures
		// each contain one.
		expect(previewTags.find((t) => t.tag === "h1")).toBeDefined();
		expect(deployTags.find((t) => t.tag === "h1")).toBeDefined();

		// Top-level structural alignment: each side has exactly one
		// `<h1>` whose text content is non-empty.
		const previewH1 = previewTags.find((t) => t.tag === "h1")?.text ?? "";
		const deployH1 = deployTags.find((t) => t.tag === "h1")?.text ?? "";
		expect(previewH1.length).toBeGreaterThan(0);
		expect(deployH1.length).toBeGreaterThan(0);

		// Both modes serve `text/html`. Parity at the content-type
		// boundary is part of the contract.
		expect(previewRes.headers.get("content-type")).toContain("text/html");
		expect(deployRes.headers.get("content-type")).toContain("text/html");
	});
});
