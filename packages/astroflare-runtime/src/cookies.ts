/**
 * `Astro.cookies` — Astro-shaped per-request cookie helper.
 *
 * Reads parse the `Cookie` request header lazily on first read; writes
 * accumulate `Set-Cookie` strings that the framework merges into the
 * outgoing `Response` (`headers()` returns the staged list).
 *
 * Astro's surface: `get`, `has`, `set`, `delete`, `headers()`. We mirror
 * the shape verbatim.
 */
import type { AstroCookieSetOptions, AstroCookieValue, AstroCookies } from "@astroflare/core";

export class CookieJar implements AstroCookies {
	#parsed: Map<string, string> | null = null;
	readonly #request: Request | undefined;
	readonly #setCookies: string[] = [];

	constructor(request: Request | undefined) {
		this.#request = request;
	}

	get(name: string): AstroCookieValue | undefined {
		const value = this.#read().get(name);
		if (value === undefined) return undefined;
		return makeValue(value);
	}

	has(name: string): boolean {
		return this.#read().has(name);
	}

	set(name: string, value: string, options: AstroCookieSetOptions = {}): void {
		this.#setCookies.push(serializeSetCookie(name, value, options));
		// Reflect in the parsed map so a subsequent get() in the same
		// request sees the write — Astro's surface behaves this way.
		this.#read().set(name, value);
	}

	delete(name: string, options: AstroCookieSetOptions = {}): void {
		const opts: AstroCookieSetOptions = {
			...options,
			expires: new Date(0),
			maxAge: 0,
		};
		this.#setCookies.push(serializeSetCookie(name, "", opts));
		this.#read().delete(name);
	}

	headers(): readonly string[] {
		return this.#setCookies;
	}

	#read(): Map<string, string> {
		if (this.#parsed) return this.#parsed;
		this.#parsed = parseCookieHeader(this.#request?.headers.get("cookie"));
		return this.#parsed;
	}
}

function makeValue(raw: string): AstroCookieValue {
	return {
		value: raw,
		json(): unknown {
			return JSON.parse(raw);
		},
		number(): number {
			return Number(raw);
		},
		boolean(): boolean {
			return raw === "true";
		},
	};
}

/**
 * Permissive cookie-header parser. Accepts the `name=value; name2=value2`
 * shape per RFC 6265 §5.4. We URL-decode values (Astro does), and skip
 * malformed pairs rather than throwing — a single bad cookie should not
 * break the request.
 */
function parseCookieHeader(header: string | null | undefined): Map<string, string> {
	const out = new Map<string, string>();
	if (!header) return out;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const name = part.slice(0, eq).trim();
		if (!name) continue;
		const raw = part.slice(eq + 1).trim();
		try {
			out.set(name, decodeURIComponent(raw));
		} catch {
			out.set(name, raw);
		}
	}
	return out;
}

function serializeSetCookie(name: string, value: string, options: AstroCookieSetOptions): string {
	const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
	if (options.domain) parts.push(`Domain=${options.domain}`);
	if (options.path) parts.push(`Path=${options.path}`);
	if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
	if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
	if (options.httpOnly) parts.push("HttpOnly");
	if (options.secure) parts.push("Secure");
	if (options.sameSite !== undefined) {
		const v = options.sameSite;
		const token = v === true ? "Strict" : v === false ? undefined : capitalize(v);
		if (token) parts.push(`SameSite=${token}`);
	}
	return parts.join("; ");
}

function capitalize(s: string): string {
	if (s.length === 0) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}
