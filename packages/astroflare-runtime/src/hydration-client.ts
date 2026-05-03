/**
 * Browser-side hydration runtime (Phase 16).
 *
 * Defines the `<astro-island>` custom element. On `connectedCallback`,
 * each island reads its `client:*` directive and schedules hydration
 * via the matching trigger:
 *
 *   client:load    — hydrate immediately (next microtask)
 *   client:idle    — hydrate via `requestIdleCallback` (or setTimeout
 *                    fallback)
 *   client:visible — hydrate when an `IntersectionObserver` reports
 *                    the island intersects the viewport
 *   client:media   — hydrate when `window.matchMedia(query)` matches
 *
 * On hydration:
 *   1. Read props from `<script type="application/json"
 *      data-aflare-props>`.
 *   2. Remove the props script so it doesn't show up in the rendered
 *      tree.
 *   3. Dynamic-import the `component-url` (a path served by the
 *      preview / deploy server).
 *   4. Call `module.mount(island, props)` (or `module.default(island,
 *      props)`) — the bundle's contract for connecting itself to the
 *      DOM.
 *
 * The mount function decides what framework runs (React, vanilla JS,
 * Solid, …). Phase 16 ships the framework-agnostic plumbing; Phase 16a
 * adds an automatic React adapter so users can deploy a `.tsx` file
 * without writing the mount glue themselves.
 *
 * Carve-outs (Phase 16):
 *   - `client:only` (skip SSR entirely) is functionally equivalent to
 *     today's behaviour for `.tsx` imports — the SSR'd content is
 *     empty by default and the mount call replaces it. The `only`
 *     directive will get its own dedicated path in Phase 17.
 *   - No island error reporting beyond `console.error`. A future
 *     overlay could surface failures.
 *   - No "rehydration on prop change" — props are read once at mount
 *     time. SPA-style updates are the user component's job.
 */

const ISLAND_TAG = "astro-island";

interface IslandModule {
	mount?: (element: HTMLElement, props: Record<string, unknown>) => void | Promise<void>;
	default?: (element: HTMLElement, props: Record<string, unknown>) => void | Promise<void>;
}

interface IslandDirective {
	mode: "load" | "idle" | "visible" | "media" | "only";
	mediaQuery?: string;
}

/**
 * The custom element class is built lazily inside `registerAstroIsland`
 * because `HTMLElement` only exists in browser-like environments. Test
 * suites that import this module under plain Node (no happy-dom) would
 * otherwise crash at module-load time on `class … extends HTMLElement`.
 */
function buildIslandClass(): CustomElementConstructor {
	return class AstroIslandElement extends HTMLElement {
		#hydrated = false;

		connectedCallback(): void {
			if (this.#hydrated) return;
			this.#hydrated = true;
			const directive = this.#readDirective();
			this.#schedule(directive);
		}

		#readDirective(): IslandDirective {
			for (const name of this.getAttributeNames()) {
				if (!name.startsWith("client:")) continue;
				const mode = name.slice("client:".length) as IslandDirective["mode"];
				const value = this.getAttribute(name) ?? "";
				return value ? { mode, mediaQuery: value } : { mode };
			}
			return { mode: "load" };
		}

		#schedule(d: IslandDirective): void {
			switch (d.mode) {
				case "load":
				case "only":
					queueMicrotask(() => this.#hydrate());
					return;
				case "idle":
					this.#scheduleIdle();
					return;
				case "visible":
					this.#scheduleVisible();
					return;
				case "media":
					this.#scheduleMedia(d.mediaQuery);
					return;
			}
		}

		#scheduleIdle(): void {
			const ric = (
				window as unknown as {
					requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
				}
			).requestIdleCallback;
			if (typeof ric === "function") {
				ric(() => this.#hydrate(), { timeout: 2000 });
			} else {
				setTimeout(() => this.#hydrate(), 200);
			}
		}

		#scheduleVisible(): void {
			if (typeof IntersectionObserver !== "function") {
				queueMicrotask(() => this.#hydrate());
				return;
			}
			const observer = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						observer.disconnect();
						this.#hydrate();
						return;
					}
				}
			});
			observer.observe(this);
		}

		#scheduleMedia(query: string | undefined): void {
			if (!query || typeof window.matchMedia !== "function") {
				queueMicrotask(() => this.#hydrate());
				return;
			}
			const mq = window.matchMedia(query);
			if (mq.matches) {
				queueMicrotask(() => this.#hydrate());
				return;
			}
			const onChange = (ev: MediaQueryListEvent): void => {
				if (!ev.matches) return;
				mq.removeEventListener("change", onChange);
				this.#hydrate();
			};
			mq.addEventListener("change", onChange);
		}

		async #hydrate(): Promise<void> {
			const url = this.getAttribute("component-url");
			if (!url) {
				console.warn("[astroflare] island missing component-url — skipping hydration", this);
				return;
			}
			const propsScript = this.querySelector<HTMLScriptElement>("script[data-aflare-props]");
			const props = parseProps(propsScript?.textContent);
			propsScript?.remove();

			try {
				const mod: IslandModule = (await import(url)) as IslandModule;
				const mount = mod.mount ?? mod.default;
				if (typeof mount !== "function") {
					console.error(`[astroflare] island module at ${url} has no \`mount\` or default export`);
					return;
				}
				await mount(this, props);
			} catch (err) {
				console.error("[astroflare] island hydration failed", url, err);
			}
		}
	};
}

function parseProps(json: string | null | undefined): Record<string, unknown> {
	if (!json) return {};
	try {
		const parsed = JSON.parse(json) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch (err) {
		console.warn("[astroflare] island props JSON parse failed", err);
	}
	return {};
}

/**
 * Define the `<astro-island>` custom element. Idempotent — multiple
 * `<script src>` includes (a stray SSR re-injection, a navigation
 * that re-evaluates the bootstrap) all share one definition.
 *
 * No-op outside the browser (no `customElements`).
 */
export function registerAstroIsland(): void {
	if (typeof customElements === "undefined") return;
	if (customElements.get(ISLAND_TAG)) return;
	customElements.define(ISLAND_TAG, buildIslandClass());
}

// Auto-register when the module is loaded as a script in a browser.
if (typeof customElements !== "undefined" && typeof window !== "undefined") {
	registerAstroIsland();
}

/**
 * Source string for the hydration client — exposed (the same way
 * `HMR_CLIENT_SOURCE` is) so the preview server can serve it without a
 * separate build step.
 *
 * Built by hand to mirror the class above. Kept short on purpose;
 * Phase 16a may move to a real bundle when the React adapter joins the
 * party.
 */
export const HYDRATION_CLIENT_SOURCE = `// astroflare hydration client
const ISLAND_TAG = "astro-island";

class AstroIslandElement extends HTMLElement {
	#hydrated = false;
	connectedCallback() {
		if (this.#hydrated) return;
		this.#hydrated = true;
		const d = this.#readDirective();
		this.#schedule(d);
	}
	#readDirective() {
		for (const name of this.getAttributeNames()) {
			if (!name.startsWith("client:")) continue;
			const mode = name.slice(7);
			const value = this.getAttribute(name) || "";
			return value ? { mode, mediaQuery: value } : { mode };
		}
		return { mode: "load" };
	}
	#schedule(d) {
		switch (d.mode) {
			case "load":
			case "only":
				queueMicrotask(() => this.#hydrate());
				return;
			case "idle": {
				const ric = window.requestIdleCallback;
				if (typeof ric === "function") ric(() => this.#hydrate(), { timeout: 2000 });
				else setTimeout(() => this.#hydrate(), 200);
				return;
			}
			case "visible": {
				if (typeof IntersectionObserver !== "function") {
					queueMicrotask(() => this.#hydrate());
					return;
				}
				const obs = new IntersectionObserver((entries) => {
					for (const e of entries) {
						if (e.isIntersecting) { obs.disconnect(); this.#hydrate(); return; }
					}
				});
				obs.observe(this);
				return;
			}
			case "media": {
				const q = d.mediaQuery;
				if (!q || typeof window.matchMedia !== "function") {
					queueMicrotask(() => this.#hydrate());
					return;
				}
				const mq = window.matchMedia(q);
				if (mq.matches) { queueMicrotask(() => this.#hydrate()); return; }
				const onChange = (ev) => { if (ev.matches) { mq.removeEventListener("change", onChange); this.#hydrate(); } };
				mq.addEventListener("change", onChange);
				return;
			}
		}
	}
	async #hydrate() {
		const url = this.getAttribute("component-url");
		if (!url) { console.warn("[astroflare] island missing component-url"); return; }
		const propsScript = this.querySelector("script[data-aflare-props]");
		let props = {};
		if (propsScript && propsScript.textContent) {
			try {
				const parsed = JSON.parse(propsScript.textContent);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) props = parsed;
			} catch (err) { console.warn("[astroflare] island props parse failed", err); }
		}
		propsScript && propsScript.remove();
		try {
			const mod = await import(url);
			const mount = mod.mount || mod.default;
			if (typeof mount !== "function") {
				console.error("[astroflare] island module at", url, "has no mount or default export");
				return;
			}
			await mount(this, props);
		} catch (err) {
			console.error("[astroflare] island hydration failed", url, err);
		}
	}
}

if (typeof customElements !== "undefined" && !customElements.get(ISLAND_TAG)) {
	customElements.define(ISLAND_TAG, AstroIslandElement);
}
`;
