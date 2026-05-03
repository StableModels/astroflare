import { describe, expect, it } from "vitest";
import { injectHmrScript } from "./inject-hmr.js";

const SCRIPT = "console.log(1)";

describe("injectHmrScript", () => {
	it("inserts before </head> when present", () => {
		const out = injectHmrScript("<html><head><title>x</title></head><body/></html>", SCRIPT);
		expect(out).toBe(
			'<html><head><title>x</title><script type="module">console.log(1)</script></head><body/></html>',
		);
	});

	it("falls back to before </body> when no head", () => {
		const out = injectHmrScript("<html><body><p>x</p></body></html>", SCRIPT);
		expect(out).toBe(
			'<html><body><p>x</p><script type="module">console.log(1)</script></body></html>',
		);
	});

	it("appends when neither head nor body", () => {
		const out = injectHmrScript("<p>just a fragment</p>", SCRIPT);
		expect(out).toBe('<p>just a fragment</p><script type="module">console.log(1)</script>');
	});

	it("matches case-insensitively", () => {
		const out = injectHmrScript("<HTML><HEAD></HEAD><BODY/></HTML>", SCRIPT);
		expect(out).toContain('<script type="module">');
		expect(out.indexOf('<script type="module">')).toBeLessThan(out.indexOf("</HEAD>"));
	});

	it("uses the last occurrence (defensive against literal </head> in content)", () => {
		const html = "<html><head><pre>example: &lt;/head&gt;</pre></head><body/></html>";
		const out = injectHmrScript(html, SCRIPT);
		// Script is inserted at the last </head>, which is after <pre>.
		const scriptIdx = out.indexOf('<script type="module">');
		const pre = out.indexOf("<pre>");
		expect(scriptIdx).toBeGreaterThan(pre);
	});
});
