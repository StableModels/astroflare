/**
 * Prefetch client (Phase 17).
 *
 * Speeds up navigation by prefetching the HTML for same-origin links
 * before the user clicks them. Two strategies, opt-in per link via
 * `data-aflare-prefetch`:
 *
 *   - `hover`  — fetch on `mouseenter` / `focus`. Default.
 *   - `viewport` — fetch when the link enters the viewport (IntersectionObserver).
 *   - `tap`    — fetch on `mousedown` / `touchstart` / `pointerdown` (Phase 19).
 *               Wins ~80–200 ms over the `click` event because the browser
 *               doesn't wait for `mouseup`. Useful for slow links the user is
 *               about to click.
 *
 * The fetcher uses `fetch(..., {priority: "low"})` with an in-memory
 * URL set to dedupe. Prefetch responses go into the browser's HTTP
 * cache; the subsequent click reuses them. Failures are silent
 * — prefetch is a hint, never load-bearing.
 *
 * Two surfaces (mirrors `view-transitions-client.ts`):
 *   - `installPrefetch(target?)` — typed entrypoint tests drive.
 *   - `PREFETCH_CLIENT_SOURCE` — the source string the server serves.
 */

export interface InstallPrefetchOptions {
	/** Override `fetch` — tests inject a spy. Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
	/** Hook fired after each prefetch resolves (success or failure). Tests use this. */
	onPrefetch?: (url: string, ok: boolean) => void;
}

export interface PrefetchClient {
	dispose(): void;
}

/** Programmatic entrypoint. */
export function installPrefetch(options: InstallPrefetchOptions = {}): PrefetchClient {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const seen = new Set<string>();

	async function prefetch(href: string): Promise<void> {
		const url = new URL(href, location.href);
		if (url.origin !== location.origin) return;
		const key = url.pathname + url.search;
		if (seen.has(key)) return;
		seen.add(key);
		try {
			// `priority: "low"` is a fetch-priority hint (Chromium-first;
			// other browsers ignore it). Standard since lib.dom.d.ts 2024.
			const res = await fetchImpl(url.href, {
				headers: { "x-aflare-prefetch": "1" },
				priority: "low",
			});
			options.onPrefetch?.(url.href, res.ok);
		} catch {
			options.onPrefetch?.(url.href, false);
		}
	}

	const onHover = (ev: Event): void => {
		const link = (ev.target as Element | null)?.closest?.("a[data-aflare-prefetch]");
		if (!(link instanceof HTMLAnchorElement)) return;
		const strategy = link.dataset.aflarePrefetch || "hover";
		if (strategy !== "hover") return;
		const href = link.getAttribute("href");
		if (!href) return;
		void prefetch(href);
	};

	const onTap = (ev: Event): void => {
		const link = (ev.target as Element | null)?.closest?.("a[data-aflare-prefetch]");
		if (!(link instanceof HTMLAnchorElement)) return;
		if (link.dataset.aflarePrefetch !== "tap") return;
		const href = link.getAttribute("href");
		if (!href) return;
		void prefetch(href);
	};

	let io: IntersectionObserver | null = null;
	if (typeof IntersectionObserver === "function") {
		io = new IntersectionObserver((entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				const link = e.target as HTMLAnchorElement;
				const href = link.getAttribute("href");
				if (href) void prefetch(href);
				io?.unobserve(link);
			}
		});
		const links = document.querySelectorAll<HTMLAnchorElement>(
			'a[data-aflare-prefetch="viewport"]',
		);
		for (const link of Array.from(links)) {
			io.observe(link);
		}
	}

	document.addEventListener("mouseover", onHover, true);
	document.addEventListener("focusin", onHover, true);
	document.addEventListener("mousedown", onTap, true);
	document.addEventListener("touchstart", onTap, true);

	return {
		dispose(): void {
			document.removeEventListener("mouseover", onHover, true);
			document.removeEventListener("focusin", onHover, true);
			document.removeEventListener("mousedown", onTap, true);
			document.removeEventListener("touchstart", onTap, true);
			io?.disconnect();
		},
	};
}

/**
 * String form for the server's `/_aflare/prefetch.js` route.
 */
export const PREFETCH_CLIENT_SOURCE = `// astroflare prefetch client
const seen = new Set();
async function prefetch(href) {
	const url = new URL(href, location.href);
	if (url.origin !== location.origin) return;
	const key = url.pathname + url.search;
	if (seen.has(key)) return;
	seen.add(key);
	try {
		await fetch(url.href, { headers: { "x-aflare-prefetch": "1" }, priority: "low" });
	} catch {}
}
const onHover = (ev) => {
	const link = ev.target?.closest?.("a[data-aflare-prefetch]");
	if (!link) return;
	const strategy = link.dataset.aflarePrefetch || "hover";
	if (strategy !== "hover") return;
	const href = link.getAttribute("href");
	if (href) prefetch(href);
};
if (typeof IntersectionObserver === "function") {
	const io = new IntersectionObserver((entries) => {
		for (const e of entries) {
			if (!e.isIntersecting) continue;
			const link = e.target;
			const href = link.getAttribute("href");
			if (href) prefetch(href);
			io.unobserve(link);
		}
	});
	for (const link of Array.from(document.querySelectorAll('a[data-aflare-prefetch="viewport"]'))) {
		io.observe(link);
	}
}
const onTap = (ev) => {
	const link = ev.target?.closest?.("a[data-aflare-prefetch]");
	if (!link) return;
	if (link.dataset.aflarePrefetch !== "tap") return;
	const href = link.getAttribute("href");
	if (href) prefetch(href);
};
document.addEventListener("mouseover", onHover, true);
document.addEventListener("focusin", onHover, true);
document.addEventListener("mousedown", onTap, true);
document.addEventListener("touchstart", onTap, true);
`;
