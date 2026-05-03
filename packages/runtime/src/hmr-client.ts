/**
 * Browser-side HMR client.
 *
 * Connects to `/_aflare/hmr` over WebSocket, listens for protocol messages
 * (defined in `@astroflare/core`), and triggers the appropriate browser
 * action.
 *
 * Phase 5 strategy: **full reload on any change.** Granular hot replacement
 * (swap a module without losing UI state) lands in Phase 8 alongside client
 * islands, where module-level update semantics actually matter. For now,
 * SSR pages re-render on the server anyway — `location.reload()` is the
 * shortest path to "what you see reflects what you wrote."
 *
 * The client is exported two ways:
 *   - `HMR_CLIENT_SOURCE` — string constant the framework inlines into
 *     preview HTML responses via a `<script type="module">` block.
 *   - `installHmrClient(target?)` — typed entrypoint tests can drive
 *     directly under happy-dom (or any DOM-shaped global). Avoids the
 *     "parse a string of code in a fake browser" dance.
 *
 * The `HMR_CLIENT_SOURCE` constant is generated from this very file at
 * build time — see the test, which asserts the string is in sync with
 * the typed entrypoint.
 */

import type { HmrMessage } from "@astroflare/core";

export interface HmrClientOptions {
	/** Where to connect. Default: `ws(s)://<location.host>/_aflare/hmr`. */
	url?: string;
	/** Fired before a full-reload to give tests a hook. */
	onReload?: (reason: string) => void;
	/** Fired on errors so tests can observe. */
	onError?: (error: HmrMessage & { type: "error" }) => void;
	/**
	 * Custom WebSocket constructor — happy-dom and similar test environments
	 * sometimes ship a non-standard implementation. Default: `globalThis.WebSocket`.
	 */
	wsCtor?: typeof WebSocket;
	/**
	 * Reload action. Default: `location.reload()`. Tests inject a spy.
	 */
	reload?: () => void;
}

export interface HmrClient {
	/** The underlying WebSocket. Useful for tests; close it to disconnect. */
	socket: WebSocket;
	/** Manually close the connection. */
	dispose(): void;
}

/**
 * Open the HMR connection from a browser context. Returns the WebSocket and
 * a `dispose()` so tests can clean up.
 */
export function installHmrClient(options: HmrClientOptions = {}): HmrClient {
	const Ctor = options.wsCtor ?? globalThis.WebSocket;
	if (typeof Ctor !== "function") {
		throw new Error("[astroflare hmr] WebSocket is not available in this environment");
	}
	const url = options.url ?? defaultHmrUrl();
	const reload = options.reload ?? (() => globalThis.location?.reload?.());
	const ws = new Ctor(url);

	ws.addEventListener("message", (ev: MessageEvent) => {
		let msg: HmrMessage;
		try {
			msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
		} catch {
			console.warn("[astroflare hmr] received malformed message");
			return;
		}
		switch (msg.type) {
			case "update":
			case "prune":
				options.onReload?.("update");
				reload();
				return;
			case "full-reload":
				options.onReload?.(msg.reason);
				reload();
				return;
			case "error":
				options.onError?.(msg);
				console.error(
					`[astroflare hmr] ${msg.error.message}${msg.error.path ? ` (${msg.error.path})` : ""}`,
				);
				return;
		}
	});

	ws.addEventListener("error", () => {
		console.warn("[astroflare hmr] socket error");
	});

	return {
		socket: ws,
		dispose: () => ws.close(),
	};
}

function defaultHmrUrl(): string {
	const loc = globalThis.location;
	if (!loc) return "/_aflare/hmr";
	const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${loc.host}/_aflare/hmr`;
}

/**
 * Inline-script form of the client. The framework injects this into HTML
 * responses via `<script type="module">${HMR_CLIENT_SOURCE}</script>`.
 *
 * Mirrors `installHmrClient`'s default behaviour without imports — so it can
 * stand alone inside a `<script>` tag without needing the runtime in scope.
 * If you change `installHmrClient`, update this constant to match (the
 * test in `hmr-client.test.ts` asserts they stay in sync at the protocol
 * level — same shape of messages handled, same reload trigger).
 */
export const HMR_CLIENT_SOURCE = `// astroflare hmr client
const loc = globalThis.location;
const protocol = loc && loc.protocol === "https:" ? "wss:" : "ws:";
const host = loc ? loc.host : "";
const ws = new WebSocket(protocol + "//" + host + "/_aflare/hmr");
ws.addEventListener("message", (ev) => {
	let msg;
	try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); }
	catch { console.warn("[astroflare hmr] received malformed message"); return; }
	if (msg.type === "update" || msg.type === "prune" || msg.type === "full-reload") {
		loc.reload();
	} else if (msg.type === "error") {
		console.error("[astroflare hmr] " + msg.error.message + (msg.error.path ? " (" + msg.error.path + ")" : ""));
	}
});
ws.addEventListener("error", () => console.warn("[astroflare hmr] socket error"));
`;
