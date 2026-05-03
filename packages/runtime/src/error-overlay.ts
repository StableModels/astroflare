/**
 * Modal error overlay (Phase 19).
 *
 * Replaces silent `console.error` for two browser-side surfaces:
 *
 *   - Hydration failures (island module fails to import / `mount`
 *     throws) — `hydration-client.ts` calls `showAstroflareError(...)`.
 *   - HMR error messages (Phase 5's `hmr-client` already routes
 *     errors through `onError`; the auto-injected wrapper now points
 *     `onError` at this overlay).
 *
 * The overlay is a single fixed-position `<div>` appended to
 * `document.body`. Calling `showAstroflareError` while one is already
 * visible replaces the previous content. The user dismisses with the
 * `×` button or by pressing `Esc`. No state lives outside the DOM.
 *
 * Production builds should NOT ship this — it's a dev/preview affordance.
 * The deploy server only injects it in preview pages; production deploys
 * skip the auto-include.
 *
 * Two surfaces:
 *   - `showAstroflareError({ title, detail })` — programmatic.
 *   - `ERROR_OVERLAY_CLIENT_SOURCE` — the same logic as a string, for
 *     the auto-injected `<script>` to ship.
 */

const OVERLAY_ID = "aflare-error-overlay";

export interface AflareErrorReport {
	title: string;
	/** Multi-line detail text. Newlines preserved; HTML escaped. */
	detail?: string;
	/** Optional source URL (the failing module / file). */
	source?: string;
}

/**
 * Show or update the error overlay. Idempotent: subsequent calls
 * replace the body of the existing overlay.
 */
export function showAstroflareError(report: AflareErrorReport): void {
	if (typeof document === "undefined") return;
	let host = document.getElementById(OVERLAY_ID);
	if (!host) {
		host = document.createElement("div");
		host.id = OVERLAY_ID;
		applyHostStyles(host);
		document.body.appendChild(host);
		document.addEventListener("keydown", onKeydown);
	}
	host.innerHTML = renderOverlayMarkup(report);
	const close = host.querySelector<HTMLButtonElement>("[data-aflare-close]");
	close?.addEventListener("click", dismissAstroflareError);
}

/** Remove the overlay, if present. */
export function dismissAstroflareError(): void {
	if (typeof document === "undefined") return;
	const host = document.getElementById(OVERLAY_ID);
	if (!host) return;
	host.remove();
	document.removeEventListener("keydown", onKeydown);
}

function onKeydown(ev: KeyboardEvent): void {
	if (ev.key === "Escape") dismissAstroflareError();
}

function applyHostStyles(host: HTMLElement): void {
	host.style.cssText = [
		"position:fixed",
		"inset:0",
		"z-index:2147483647",
		"background:rgba(0,0,0,0.55)",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"font-family:ui-sans-serif,system-ui,-apple-system,sans-serif",
		"color:#f8fafc",
	].join(";");
}

function renderOverlayMarkup(report: AflareErrorReport): string {
	const detail = report.detail ? escapeHtml(report.detail) : "";
	const source = report.source ? escapeHtml(report.source) : "";
	return [
		'<div style="background:#0f172a;border:1px solid #ef4444;border-radius:8px;',
		"padding:24px;max-width:720px;width:90%;max-height:80vh;overflow:auto;",
		'box-shadow:0 10px 40px rgba(0,0,0,0.5)">',
		'<button data-aflare-close style="float:right;background:transparent;',
		'border:0;color:#94a3b8;font-size:24px;cursor:pointer;line-height:1" ',
		'aria-label="Dismiss">&times;</button>',
		'<div style="color:#fca5a5;font-size:13px;letter-spacing:0.08em;',
		'text-transform:uppercase;margin-bottom:6px">Astroflare error</div>',
		`<h2 style="margin:0 0 12px 0;font-size:18px">${escapeHtml(report.title)}</h2>`,
		source ? `<div style="color:#94a3b8;font-size:13px;margin-bottom:12px">${source}</div>` : "",
		detail
			? `<pre style="white-space:pre-wrap;background:#020617;padding:12px;border-radius:4px;font-size:13px;line-height:1.4;margin:0">${detail}</pre>`
			: "",
		"</div>",
	].join("");
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * String-form for embedding into the auto-injected dev/preview
 * bootstrap. The hydration + HMR clients call into the runtime
 * directly when bundled; this string is for environments where the
 * runtime isn't already loaded.
 */
export const ERROR_OVERLAY_CLIENT_SOURCE = `// astroflare error overlay
const OVERLAY_ID = "${OVERLAY_ID}";
function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderMarkup(r) {
	const detail = r.detail ? escapeHtml(r.detail) : "";
	const source = r.source ? escapeHtml(r.source) : "";
	return [
		'<div style="background:#0f172a;border:1px solid #ef4444;border-radius:8px;padding:24px;max-width:720px;width:90%;max-height:80vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,0.5)">',
		'<button data-aflare-close style="float:right;background:transparent;border:0;color:#94a3b8;font-size:24px;cursor:pointer;line-height:1" aria-label="Dismiss">&times;</button>',
		'<div style="color:#fca5a5;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px">Astroflare error</div>',
		'<h2 style="margin:0 0 12px 0;font-size:18px">' + escapeHtml(r.title) + '</h2>',
		source ? '<div style="color:#94a3b8;font-size:13px;margin-bottom:12px">' + source + '</div>' : '',
		detail ? '<pre style="white-space:pre-wrap;background:#020617;padding:12px;border-radius:4px;font-size:13px;line-height:1.4;margin:0">' + detail + '</pre>' : '',
		'</div>',
	].join("");
}
function dismiss() {
	const host = document.getElementById(OVERLAY_ID);
	if (host) host.remove();
}
window.__aflareShowError = function(report) {
	let host = document.getElementById(OVERLAY_ID);
	if (!host) {
		host = document.createElement("div");
		host.id = OVERLAY_ID;
		host.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#f8fafc";
		document.body.appendChild(host);
		document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") dismiss(); });
	}
	host.innerHTML = renderMarkup(report);
	const close = host.querySelector("[data-aflare-close]");
	if (close) close.addEventListener("click", dismiss);
};
`;
