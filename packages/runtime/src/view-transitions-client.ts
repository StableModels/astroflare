/**
 * View Transitions client (Phase 17).
 *
 * SPA-style navigation wrapped in the browser's View Transitions API
 * (`document.startViewTransition`) so the platform handles the
 * cross-fade automatically. Pages that opt in carry a marker
 * `<meta name="aflare-view-transitions">`; the script intercepts
 * same-origin link clicks and history navigation, fetches the next
 * document, swaps `<head>` + `<body>`, and re-runs scripts.
 *
 * Two surfaces, mirroring `hmr-client.ts` / `hydration-client.ts`:
 *   - `installViewTransitions(target?)` — typed entrypoint tests drive.
 *   - `VIEW_TRANSITIONS_CLIENT_SOURCE` — the source as a string the
 *     server inlines or serves at `/_aflare/view-transitions.js`.
 *
 * Browsers without `document.startViewTransition` get a synchronous
 * DOM swap (no animation) — graceful degradation, no script error.
 */

export interface InstallViewTransitionsOptions {
	/** Hook fired after each navigation completes. Tests use this. */
	onAfterNavigate?: (url: string) => void;
	/** Override `fetch` — tests inject a spy. Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
}

interface ViewTransitionRoot {
	startViewTransition?: (callback: () => void | Promise<void>) => unknown;
}

export interface ViewTransitionsClient {
	/** Detach all listeners and stop intercepting navigation. */
	dispose(): void;
}

/**
 * Programmatic entrypoint. Call from a real or simulated DOM.
 * Returns a `dispose()` that pulls the listeners off again — tests
 * use it; production scripts never disposes (the page lifetime is
 * the script lifetime).
 */
export function installViewTransitions(
	options: InstallViewTransitionsOptions = {},
): ViewTransitionsClient {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

	const onClick = (ev: Event): void => {
		const link = findAnchor(ev.target as Element | null);
		if (!link) return;
		const mouseEv = ev as MouseEvent;
		// Respect modifier keys + non-primary buttons + target=_blank: the
		// user is asking the browser to do its native thing.
		if (
			mouseEv.button !== 0 ||
			mouseEv.metaKey ||
			mouseEv.ctrlKey ||
			mouseEv.shiftKey ||
			mouseEv.altKey ||
			link.target === "_blank"
		) {
			return;
		}
		const href = link.getAttribute("href");
		if (!href) return;
		const url = new URL(href, location.href);
		// Cross-origin → let the browser handle it natively.
		if (url.origin !== location.origin) return;
		// Hash-only nav on the same page → let the browser scroll.
		if (url.pathname === location.pathname && url.search === location.search && url.hash !== "") {
			return;
		}
		ev.preventDefault();
		void navigate(url.href);
	};

	const onPopState = (): void => {
		void navigate(location.href, { fromPopState: true });
	};

	async function navigate(url: string, opts: { fromPopState?: boolean } = {}): Promise<void> {
		try {
			const res = await fetchImpl(url, { headers: { "x-aflare-vt": "1" } });
			if (!res.ok) {
				location.href = url;
				return;
			}
			const html = await res.text();
			const swap = (): void => {
				applyDocument(html);
				if (!opts.fromPopState) {
					history.pushState({}, "", url);
				}
			};
			const docRoot = document as ViewTransitionRoot;
			if (typeof docRoot.startViewTransition === "function") {
				docRoot.startViewTransition(swap);
			} else {
				swap();
			}
			options.onAfterNavigate?.(url);
		} catch {
			location.href = url;
		}
	}

	document.addEventListener("click", onClick);
	window.addEventListener("popstate", onPopState);

	return {
		dispose(): void {
			document.removeEventListener("click", onClick);
			window.removeEventListener("popstate", onPopState);
		},
	};
}

function findAnchor(start: Element | null): HTMLAnchorElement | null {
	let n: Element | null = start;
	while (n) {
		if (n.tagName === "A") return n as HTMLAnchorElement;
		n = n.parentElement;
	}
	return null;
}

/**
 * Replace document content from a freshly-fetched HTML string. Swaps
 * body innerHTML (rather than replacing the `<body>` element itself,
 * which loses the live `document.body` reference in some DOM
 * implementations) and re-executes inline scripts (browsers don't
 * run inserted `<script>` content automatically).
 */
function applyDocument(html: string): void {
	const parser = new DOMParser();
	const next = parser.parseFromString(html, "text/html");

	document.title = next.title;
	document.body.innerHTML = next.body.innerHTML;
	// Re-run inline scripts in body. Module imports won't re-fetch
	// from cache, so this is cheap.
	const scripts = document.body.querySelectorAll("script");
	for (const old of Array.from(scripts)) {
		const fresh = document.createElement("script");
		for (const attr of Array.from(old.attributes)) {
			fresh.setAttribute(attr.name, attr.value);
		}
		fresh.textContent = old.textContent;
		old.replaceWith(fresh);
	}
}

/**
 * String form. Identical to the typed entrypoint above, hand-translated
 * to plain ES2020 — same pattern Phase 5/16 use. The server serves this
 * verbatim at `/_aflare/view-transitions.js`. The page imports it via
 * the marker `<meta name="aflare-view-transitions">`-triggered tag.
 */
export const VIEW_TRANSITIONS_CLIENT_SOURCE = `// astroflare view-transitions client
const onClick = (ev) => {
	const link = findAnchor(ev.target);
	if (!link) return;
	if (
		ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey ||
		link.target === "_blank"
	) return;
	const href = link.getAttribute("href");
	if (!href) return;
	const url = new URL(href, location.href);
	if (url.origin !== location.origin) return;
	if (
		url.pathname === location.pathname &&
		url.search === location.search &&
		url.hash !== ""
	) return;
	ev.preventDefault();
	navigate(url.href);
};
const onPopState = () => navigate(location.href, true);
async function navigate(url, fromPopState) {
	try {
		const res = await fetch(url, { headers: { "x-aflare-vt": "1" } });
		if (!res.ok) { location.href = url; return; }
		const html = await res.text();
		const swap = () => {
			const next = new DOMParser().parseFromString(html, "text/html");
			document.title = next.title;
			document.body.innerHTML = next.body.innerHTML;
			for (const old of Array.from(document.body.querySelectorAll("script"))) {
				const fresh = document.createElement("script");
				for (const attr of Array.from(old.attributes)) fresh.setAttribute(attr.name, attr.value);
				fresh.textContent = old.textContent;
				old.replaceWith(fresh);
			}
			if (!fromPopState) history.pushState({}, "", url);
		};
		if (typeof document.startViewTransition === "function") {
			document.startViewTransition(swap);
		} else {
			swap();
		}
	} catch { location.href = url; }
}
function findAnchor(start) {
	let n = start;
	while (n) { if (n.tagName === "A") return n; n = n.parentElement; }
	return null;
}
document.addEventListener("click", onClick);
window.addEventListener("popstate", onPopState);
`;
