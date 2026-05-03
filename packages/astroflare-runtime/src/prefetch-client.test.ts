// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREFETCH_CLIENT_SOURCE, installPrefetch } from "./prefetch-client.js";

describe("installPrefetch", () => {
	beforeEach(() => {
		document.body.innerHTML = `
			<a id="hover" href="/next" data-aflare-prefetch>hover</a>
			<a id="vp" href="/vp" data-aflare-prefetch="viewport">viewport</a>
			<a id="plain" href="/plain">plain</a>
			<a id="ext" href="https://other.example/x" data-aflare-prefetch>cross</a>
		`;
	});

	afterEach(() => {
		(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
	});

	it("prefetches on mouseover for hover-strategy links", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
		const onPrefetch = vi.fn();
		const client = installPrefetch({ fetchImpl, onPrefetch });
		try {
			document
				.getElementById("hover")
				?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
			expect(fetchImpl).toHaveBeenCalledOnce();
			expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/next");
			const opts = fetchImpl.mock.calls[0]?.[1] as RequestInit & { priority?: string };
			expect(opts?.headers).toEqual({ "x-aflare-prefetch": "1" });
			expect(opts?.priority).toBe("low");
		} finally {
			client.dispose();
		}
	});

	it("dedupes — second hover on same URL doesn't refetch", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
		const client = installPrefetch({ fetchImpl });
		try {
			const link = document.getElementById("hover");
			if (!link) throw new Error("expected link element");
			link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
			expect(fetchImpl).toHaveBeenCalledOnce();
		} finally {
			client.dispose();
		}
	});

	it("ignores plain links with no data-aflare-prefetch", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
		const client = installPrefetch({ fetchImpl });
		try {
			document
				.getElementById("plain")
				?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			client.dispose();
		}
	});

	it("ignores cross-origin URLs even when marked", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
		const client = installPrefetch({ fetchImpl });
		try {
			document.getElementById("ext")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			client.dispose();
		}
	});

	it("hover handler does not fire for viewport-strategy links", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
		const client = installPrefetch({ fetchImpl });
		try {
			// `vp` is data-aflare-prefetch="viewport"; hovering should be ignored.
			document.getElementById("vp")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			client.dispose();
		}
	});

	it("subscribes viewport-strategy links to IntersectionObserver", () => {
		const observe = vi.fn();
		const disconnect = vi.fn();
		class FakeIO {
			observe = observe;
			unobserve = vi.fn();
			disconnect = disconnect;
			constructor(public cb: IntersectionObserverCallback) {}
		}
		(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
		const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
		const client = installPrefetch({ fetchImpl });
		try {
			expect(observe).toHaveBeenCalledTimes(1);
			expect(observe.mock.calls[0]?.[0]).toBe(document.getElementById("vp"));
		} finally {
			client.dispose();
			expect(disconnect).toHaveBeenCalled();
		}
	});

	it("source string is non-empty + references the marker attribute", () => {
		expect(PREFETCH_CLIENT_SOURCE).toContain("data-aflare-prefetch");
		expect(PREFETCH_CLIENT_SOURCE).toContain("x-aflare-prefetch");
		// Phase 19 follow-up: tap strategy fires on mousedown.
		expect(PREFETCH_CLIENT_SOURCE).toContain("mousedown");
		expect(PREFETCH_CLIENT_SOURCE).toContain("touchstart");
	});

	it("prefetches on mousedown for tap-strategy links", async () => {
		document.body.innerHTML = `<a id="tap" href="/tap-target" data-aflare-prefetch="tap">go</a>`;
		const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
		const client = installPrefetch({ fetchImpl });
		try {
			document.getElementById("tap")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
			expect(fetchImpl).toHaveBeenCalledOnce();
			expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/tap-target");
		} finally {
			client.dispose();
		}
	});

	it("hover-strategy links are NOT triggered by mousedown", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
		const client = installPrefetch({ fetchImpl });
		try {
			document
				.getElementById("hover")
				?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			client.dispose();
		}
	});
});
