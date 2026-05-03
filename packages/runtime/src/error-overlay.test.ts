// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
	ERROR_OVERLAY_CLIENT_SOURCE,
	dismissAstroflareError,
	showAstroflareError,
} from "./error-overlay.js";

describe("error overlay", () => {
	afterEach(() => {
		dismissAstroflareError();
	});

	it("appends a #aflare-error-overlay element with the title", () => {
		showAstroflareError({ title: "Hydration failed" });
		const host = document.getElementById("aflare-error-overlay");
		expect(host).not.toBeNull();
		expect(host?.innerHTML).toContain("Hydration failed");
	});

	it("escapes HTML in title/detail/source", () => {
		showAstroflareError({
			title: "<script>x</script>",
			detail: 'raw < > & " oops',
			source: "/path/<file>",
		});
		const host = document.getElementById("aflare-error-overlay");
		const html = host?.innerHTML ?? "";
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&amp;");
		expect(html).toContain("&lt;file&gt;");
		expect(html).not.toContain("<script>x</script>");
	});

	it("subsequent calls replace the overlay body, not stack", () => {
		showAstroflareError({ title: "First" });
		showAstroflareError({ title: "Second" });
		const overlays = document.querySelectorAll("#aflare-error-overlay");
		expect(overlays).toHaveLength(1);
		expect(overlays[0]?.innerHTML).toContain("Second");
		expect(overlays[0]?.innerHTML).not.toContain("First");
	});

	it("the close button removes the overlay from the DOM", () => {
		showAstroflareError({ title: "x" });
		const close = document.querySelector<HTMLButtonElement>("[data-aflare-close]");
		expect(close).not.toBeNull();
		close?.click();
		expect(document.getElementById("aflare-error-overlay")).toBeNull();
	});

	it("Escape key dismisses the overlay", () => {
		showAstroflareError({ title: "x" });
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(document.getElementById("aflare-error-overlay")).toBeNull();
	});

	it("dismissAstroflareError on a missing overlay is a no-op", () => {
		dismissAstroflareError();
		expect(document.getElementById("aflare-error-overlay")).toBeNull();
	});

	it("source string defines window.__aflareShowError", () => {
		// Just check the source includes the global. Don't eval — testing
		// the typed entrypoint above already covers the behaviour.
		expect(ERROR_OVERLAY_CLIENT_SOURCE).toContain("window.__aflareShowError");
		expect(ERROR_OVERLAY_CLIENT_SOURCE).toContain("aflare-error-overlay");
	});
});
