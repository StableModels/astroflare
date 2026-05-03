// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	VIEW_TRANSITIONS_CLIENT_SOURCE,
	installViewTransitions,
} from "./view-transitions-client.js";

declare global {
	// happy-dom provides DOMParser via window. Just narrow the assertion.
	// biome-ignore lint/suspicious/noExplicitAny: test-only ambient
	var DOMParser: any;
}

describe("installViewTransitions", () => {
	beforeEach(() => {
		document.body.innerHTML = '<a id="link" href="/next">go</a>';
		// happy-dom doesn't ship `startViewTransition`; tests stub it.
	});

	afterEach(() => {
		(document as { startViewTransition?: unknown }).startViewTransition = undefined;
	});

	it("intercepts same-origin link clicks and calls fetch with the prefetch header", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response("<html><head><title>Next</title></head><body></body></html>"),
			);
		const onAfter = vi.fn();
		const client = installViewTransitions({ fetchImpl, onAfterNavigate: onAfter });

		try {
			const link = document.getElementById("link") as HTMLAnchorElement;
			const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
			link.dispatchEvent(ev);
			// Microtask flush — the click handler awaits inside.
			await new Promise((r) => setTimeout(r, 0));

			expect(fetchImpl).toHaveBeenCalledOnce();
			const callArgs = fetchImpl.mock.calls[0];
			if (!callArgs) throw new Error("expected fetch call");
			const [calledUrl, calledOpts] = callArgs;
			expect(String(calledUrl)).toContain("/next");
			expect((calledOpts as RequestInit).headers).toEqual({ "x-aflare-vt": "1" });
			expect(ev.defaultPrevented).toBe(true);
			expect(onAfter).toHaveBeenCalledWith(expect.stringContaining("/next"));
		} finally {
			client.dispose();
		}
	});

	it("ignores modifier-key clicks (lets the browser handle them natively)", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("<html><body></body></html>"));
		const client = installViewTransitions({ fetchImpl });
		try {
			const link = document.getElementById("link") as HTMLAnchorElement;
			const ev = new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				metaKey: true,
			});
			link.dispatchEvent(ev);
			await new Promise((r) => setTimeout(r, 0));
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(ev.defaultPrevented).toBe(false);
		} finally {
			client.dispose();
		}
	});

	it("ignores cross-origin links", async () => {
		document.body.innerHTML = '<a id="ext" href="https://example.org/page">x</a>';
		const fetchImpl = vi.fn();
		const client = installViewTransitions({ fetchImpl });
		try {
			document
				.getElementById("ext")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			await new Promise((r) => setTimeout(r, 0));
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			client.dispose();
		}
	});

	it("uses startViewTransition when available", async () => {
		const stvt = vi.fn((cb: () => void) => {
			cb();
			return {};
		});
		(document as { startViewTransition?: unknown }).startViewTransition = stvt;
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("<html><head><title>X</title></head><body></body></html>"));
		const client = installViewTransitions({ fetchImpl });
		try {
			document
				.getElementById("link")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			await new Promise((r) => setTimeout(r, 0));
			expect(stvt).toHaveBeenCalledOnce();
		} finally {
			client.dispose();
		}
	});

	it("dispose() detaches listeners", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("<html><body></body></html>"));
		const client = installViewTransitions({ fetchImpl });
		client.dispose();
		document
			.getElementById("link")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("source string parses as JS — sanity check the literal compiles", () => {
		// Just enough to catch a typo. We're not eval-ing it.
		expect(VIEW_TRANSITIONS_CLIENT_SOURCE).toContain("addEventListener");
		expect(VIEW_TRANSITIONS_CLIENT_SOURCE).toContain("startViewTransition");
		expect(VIEW_TRANSITIONS_CLIENT_SOURCE).toContain("x-aflare-vt");
	});
});
