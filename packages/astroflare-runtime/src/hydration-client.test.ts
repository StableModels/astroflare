/**
 * Hydration client tests under happy-dom.
 *
 * Coverage focuses on the parts that are reliably testable without a
 * working dynamic-`import()` shim:
 *   - Custom element registration is idempotent
 *   - Directive parsing reads the right `client:*` attribute
 *   - Each directive routes to the matching scheduler primitive
 *     (`requestIdleCallback`, `IntersectionObserver`, `matchMedia`)
 *   - Missing `component-url` warns
 *
 * The actual mount call (which requires a working dynamic import of a
 * synthetic module URL) is exercised via the integration tests once the
 * preview server's `/_aflare/island` route is wired up.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAstroIsland } from "./hydration-client.js";

beforeEach(() => {
	registerAstroIsland();
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

function makeIsland(attrs: Record<string, string>, inner = ""): HTMLElement {
	const el = document.createElement("astro-island");
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	el.innerHTML = inner;
	document.body.appendChild(el);
	return el;
}

describe("AstroIslandElement: registration", () => {
	it("registers the custom element exactly once", () => {
		// Second call is a no-op; otherwise customElements.define would throw.
		expect(() => registerAstroIsland()).not.toThrow();
		expect(customElements.get("astro-island")).toBeDefined();
	});
});

describe("AstroIslandElement: scheduler routing", () => {
	it("client:idle uses requestIdleCallback when available", async () => {
		const ric = vi.fn();
		(globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = ric;
		try {
			makeIsland({ "client:idle": "", "component-url": "/x.js" });
			// connectedCallback runs during appendChild; wait for queueMicrotask.
			await Promise.resolve();
			expect(ric).toHaveBeenCalledOnce();
			// Second arg is a timeout option.
			expect(ric.mock.calls[0]?.[1]).toEqual({ timeout: 2000 });
		} finally {
			(globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = undefined;
		}
	});

	it("client:visible creates an IntersectionObserver and observes the island", async () => {
		const observeSpy = vi.fn();
		const disconnectSpy = vi.fn();
		(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = function (
			this: unknown,
			_cb: IntersectionObserverCallback,
		) {
			return { observe: observeSpy, disconnect: disconnectSpy } as unknown as IntersectionObserver;
		} as unknown as typeof IntersectionObserver;
		try {
			const island = makeIsland({
				"client:visible": "",
				"component-url": "/x.js",
			});
			expect(observeSpy).toHaveBeenCalledWith(island);
		} finally {
			(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
		}
	});

	it("client:media calls matchMedia with the supplied query", async () => {
		const mqAddSpy = vi.fn();
		const mm = vi.fn(() => ({
			matches: false,
			media: "",
			addEventListener: mqAddSpy,
			removeEventListener: vi.fn(),
		}));
		(globalThis as { matchMedia?: unknown }).matchMedia = mm as unknown as typeof matchMedia;
		try {
			makeIsland({
				"client:media": "(min-width: 800px)",
				"component-url": "/x.js",
			});
			expect(mm).toHaveBeenCalledWith("(min-width: 800px)");
			// `matches: false` → registers a change listener instead of firing.
			expect(mqAddSpy).toHaveBeenCalled();
		} finally {
			(globalThis as { matchMedia?: unknown }).matchMedia = undefined;
		}
	});

	it("connectedCallback is idempotent (re-attaching the island doesn't double-schedule)", async () => {
		const ric = vi.fn();
		(globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = ric;
		try {
			const island = makeIsland({ "client:idle": "", "component-url": "/x.js" });
			expect(ric).toHaveBeenCalledOnce();
			// Move the element to a new parent — connectedCallback fires again.
			const wrap = document.createElement("div");
			document.body.appendChild(wrap);
			wrap.appendChild(island);
			expect(ric).toHaveBeenCalledOnce(); // still only once
		} finally {
			(globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = undefined;
		}
	});
});

describe("AstroIslandElement: error paths", () => {
	it("warns when component-url is missing", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		makeIsland({ "client:load": "" });
		// Wait two microtasks: schedule + hydrate.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("missing component-url"),
			expect.any(HTMLElement),
		);
	});
});

describe("HYDRATION_CLIENT_SOURCE", () => {
	it("includes the custom element registration", async () => {
		const { HYDRATION_CLIENT_SOURCE } = await import("./hydration-client.js");
		expect(HYDRATION_CLIENT_SOURCE).toContain("customElements.define");
		expect(HYDRATION_CLIENT_SOURCE).toContain("astro-island");
		expect(HYDRATION_CLIENT_SOURCE).toContain("queueMicrotask");
		expect(HYDRATION_CLIENT_SOURCE).toContain("IntersectionObserver");
		expect(HYDRATION_CLIENT_SOURCE).toContain("matchMedia");
	});

	it("guards against double-registration", async () => {
		const { HYDRATION_CLIENT_SOURCE } = await import("./hydration-client.js");
		expect(HYDRATION_CLIENT_SOURCE).toContain("!customElements.get");
	});
});
