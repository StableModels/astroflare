/**
 * Dev-mode error page.
 *
 * Renders a styled HTML response for compile / runtime errors hit during
 * preview. The body is plain HTML — no JS — and the HMR client is still
 * injected by the caller, so the page reloads automatically when the
 * source is fixed.
 *
 * The brief's Phase 9 calls for this to surface "with a useful diagnostic
 * in the HMR overlay." Phase 9 here ships the *server-rendered* version;
 * a full-screen client overlay (modal over the previously-rendered page)
 * is a small follow-up that fits into the HMR client.
 */

const ESCAPE: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};
const ESCAPE_RE = /[&<>"']/g;

function esc(value: unknown): string {
	if (value == null) return "";
	return String(value).replace(ESCAPE_RE, (c) => ESCAPE[c] as string);
}

export interface RenderErrorOptions {
	error: Error;
	requestUrl?: string;
}

export function renderErrorPage(opts: RenderErrorOptions): string {
	const { error, requestUrl } = opts;
	const stack = (error.stack ?? "").split("\n").slice(1, 6).join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Astroflare error: ${esc(error.message)}</title>
<style>
  body { font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 0; background: #1c1917; color: #fafaf9; }
  header { background: #b91c1c; color: white; padding: 16px 20px; }
  header strong { display: block; font-size: 18px; margin-bottom: 4px; }
  main { padding: 16px 20px; }
  pre { background: #0c0a09; padding: 12px 16px; border-radius: 6px; overflow: auto; color: #fbbf24; }
  small { color: #a8a29e; }
</style>
</head>
<body>
<header>
  <strong>Astroflare preview error</strong>
  <span>${esc(error.message)}</span>
</header>
<main>
  ${requestUrl ? `<p><small>while serving </small><code>${esc(requestUrl)}</code></p>` : ""}
  ${stack ? `<h2>Trace</h2><pre>${esc(stack)}</pre>` : ""}
  <p><small>This is the dev-time error page; production deploys never serve this.</small></p>
</main>
</body>
</html>
`;
}
