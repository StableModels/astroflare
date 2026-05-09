import type { HmrMessage } from "@astroflare/core";
import { describe, expect, it, vi } from "vitest";
import { HMR_CLIENT_SOURCE, buildHmrClientSource, installHmrClient } from "./hmr-client.js";

/**
 * Fake `WebSocket` for tests. We don't need a real socket — `installHmrClient`
 * only consumes message and error events, never sends. Avoids the
 * "wait for happy-dom to spin up a WS" cost and keeps the test in plain
 * Node-pool territory.
 */
class FakeWebSocket extends EventTarget {
	url: string;
	readyState = 0;
	closed = false;
	constructor(url: string) {
		super();
		this.url = url;
	}
	emit(data: HmrMessage | string): void {
		const payload = typeof data === "string" ? data : JSON.stringify(data);
		this.dispatchEvent(new MessageEvent("message", { data: payload }));
	}
	emitError(): void {
		this.dispatchEvent(new Event("error"));
	}
	close(): void {
		this.closed = true;
	}
}

function setup(): {
	socket: FakeWebSocket;
	reload: ReturnType<typeof vi.fn>;
	onError: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	dismissError: ReturnType<typeof vi.fn>;
	dispose: () => void;
} {
	let socket!: FakeWebSocket;
	const reload = vi.fn();
	const onError = vi.fn();
	const showError = vi.fn();
	const dismissError = vi.fn();
	function wsCtor(url: string): FakeWebSocket {
		socket = new FakeWebSocket(url);
		return socket;
	}
	const client = installHmrClient({
		url: "ws://test/_aflare/hmr",
		wsCtor: wsCtor as unknown as typeof WebSocket,
		reload,
		onError,
		showError,
		dismissError,
	});
	return { socket, reload, onError, showError, dismissError, dispose: client.dispose };
}

describe("installHmrClient — message handling", () => {
	it("reloads on `update` messages", () => {
		const { socket, reload } = setup();
		socket.emit({
			type: "update",
			updates: [{ path: "/src/pages/index.astro", hash: "abc", kind: "module" }],
		});
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("reloads on `prune` messages", () => {
		const { socket, reload } = setup();
		socket.emit({ type: "prune", paths: ["/x"] });
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("reloads on `full-reload` messages", () => {
		const { socket, reload } = setup();
		socket.emit({ type: "full-reload", reason: "config changed" });
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("does NOT reload on `error` messages", () => {
		const { socket, reload, onError } = setup();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		socket.emit({
			type: "error",
			error: { message: "Compile failed", path: "/src/pages/x.astro" },
		});
		expect(reload).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("invokes the overlay shim on `error` messages", () => {
		const { socket, showError } = setup();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const errMsg = {
			type: "error" as const,
			error: { message: "Compile failed", path: "/src/pages/x.astro" },
		};
		socket.emit(errMsg);
		expect(showError).toHaveBeenCalledWith(errMsg);
		consoleError.mockRestore();
	});

	it("dismisses the overlay before reloading on `update`/`prune`/`full-reload`", () => {
		const { socket, dismissError, reload } = setup();
		socket.emit({ type: "update", updates: [{ path: "/x", hash: "h", kind: "module" }] });
		expect(dismissError).toHaveBeenCalledTimes(1);
		expect(reload).toHaveBeenCalledTimes(1);
		// And again on a prune.
		socket.emit({ type: "prune", paths: ["/x"] });
		expect(dismissError).toHaveBeenCalledTimes(2);
		// And again on a full-reload.
		socket.emit({ type: "full-reload", reason: "config" });
		expect(dismissError).toHaveBeenCalledTimes(3);
	});

	it("ignores malformed payloads", () => {
		const { socket, reload } = setup();
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		socket.emit("not json");
		expect(reload).not.toHaveBeenCalled();
		expect(consoleWarn).toHaveBeenCalled();
		consoleWarn.mockRestore();
	});

	it("dispose() closes the socket", () => {
		const { socket, dispose } = setup();
		dispose();
		expect(socket.closed).toBe(true);
	});

	it("survives socket-error events without crashing", () => {
		const { socket, reload } = setup();
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		socket.emitError();
		// Subsequent message still reloads.
		socket.emit({ type: "full-reload", reason: "after error" });
		expect(reload).toHaveBeenCalledTimes(1);
		consoleWarn.mockRestore();
	});

	it("URL is constructed from window location when not specified", () => {
		// Stub a global location for this test.
		const originalLocation = (globalThis as { location?: Location }).location;
		(globalThis as { location: { protocol: string; host: string } }).location = {
			protocol: "https:",
			host: "app.example",
		};
		try {
			let captured = "";
			function wsCtor(url: string): FakeWebSocket {
				captured = url;
				return new FakeWebSocket(url);
			}
			installHmrClient({
				wsCtor: wsCtor as unknown as typeof WebSocket,
				reload: () => undefined,
			});
			expect(captured).toBe("wss://app.example/_aflare/hmr");
		} finally {
			(globalThis as { location?: Location }).location = originalLocation;
		}
	});
});

describe("HMR_CLIENT_SOURCE constant", () => {
	it("is a non-trivial JS payload", () => {
		expect(HMR_CLIENT_SOURCE).toContain("WebSocket");
		expect(HMR_CLIENT_SOURCE).toContain("/_aflare/hmr");
		expect(HMR_CLIENT_SOURCE).toContain("update");
		expect(HMR_CLIENT_SOURCE).toContain("full-reload");
	});

	it("inlines the overlay shim so error events surface a modal", () => {
		// `ERROR_OVERLAY_CLIENT_SOURCE` defines `window.__aflareShowError`
		// and the projector inside the HMR loop calls into it on each
		// `error` message. Same behaviour as `installHmrClient` ↔
		// `showAstroflareError`.
		expect(HMR_CLIENT_SOURCE).toContain("window.__aflareShowError");
		expect(HMR_CLIENT_SOURCE).toContain("aflare-error-overlay");
	});

	it("stays lean (under 6 KB — protocol client + inlined overlay shim)", () => {
		// Original target was 3 KB for the bare HMR loop. The default-
		// injected client now bundles `ERROR_OVERLAY_CLIENT_SOURCE` and
		// the structured-error projector so the iframe surfaces compile
		// failures end-to-end without any host-side wiring; that pushes
		// the budget up but keeps it well under one HTTP buffer's worth
		// of bytes.
		expect(HMR_CLIENT_SOURCE.length).toBeLessThan(6 * 1024);
	});

	it("equals buildHmrClientSource() with default options", () => {
		expect(HMR_CLIENT_SOURCE).toBe(buildHmrClientSource());
	});
});

describe("buildHmrClientSource", () => {
	it("substitutes a custom socketPath into the WebSocket URL", () => {
		const src = buildHmrClientSource({ socketPath: "/s/site-abc/_aflare/hmr" });
		expect(src).toContain('"/s/site-abc/_aflare/hmr"');
		expect(src).not.toContain('"/_aflare/hmr"');
	});

	it("rejects relative socketPaths", () => {
		expect(() => buildHmrClientSource({ socketPath: "_aflare/hmr" })).toThrow(/must start with/);
	});

	it("safely escapes the socketPath as a JS literal", () => {
		// Pathological but valid path component — JSON.stringify keeps the
		// embedded quote escaped so the script doesn't get re-parsed by the
		// browser as a closing literal.
		const src = buildHmrClientSource({ socketPath: '/weird"path' });
		expect(src).toContain('"/weird\\"path"');
	});
});
