/**
 * Tests for `CookieJar` — the runtime helper backing `Astro.cookies`.
 * Reads parse the request's `Cookie` header lazily; writes accumulate
 * `Set-Cookie` strings that the framework merges into the response.
 */
import { describe, expect, it } from "vitest";
import { CookieJar } from "./cookies.js";

function req(cookieHeader?: string): Request {
	const headers = new Headers();
	if (cookieHeader !== undefined) headers.set("cookie", cookieHeader);
	return new Request("https://example.test/", { headers });
}

describe("CookieJar reads", () => {
	it("returns undefined for missing cookies", () => {
		const jar = new CookieJar(req());
		expect(jar.has("session")).toBe(false);
		expect(jar.get("session")).toBeUndefined();
	});

	it("parses a single cookie", () => {
		const jar = new CookieJar(req("session=abc"));
		expect(jar.has("session")).toBe(true);
		expect(jar.get("session")?.value).toBe("abc");
	});

	it("parses multiple cookies", () => {
		const jar = new CookieJar(req("a=1; b=2; c=three"));
		expect(jar.get("a")?.value).toBe("1");
		expect(jar.get("b")?.value).toBe("2");
		expect(jar.get("c")?.value).toBe("three");
	});

	it("URL-decodes cookie values", () => {
		const jar = new CookieJar(req("greeting=hello%20world"));
		expect(jar.get("greeting")?.value).toBe("hello world");
	});

	it("skips malformed pairs but keeps the rest", () => {
		const jar = new CookieJar(req("good=yes; nope; alsogood=ok"));
		expect(jar.get("good")?.value).toBe("yes");
		expect(jar.get("alsogood")?.value).toBe("ok");
		expect(jar.has("nope")).toBe(false);
	});

	it("get().json() parses the value as JSON", () => {
		const jar = new CookieJar(req(`prefs=${encodeURIComponent('{"theme":"dark"}')}`));
		const v = jar.get("prefs");
		expect(v?.json()).toEqual({ theme: "dark" });
	});

	it("get().number() coerces to Number", () => {
		const jar = new CookieJar(req("count=42"));
		expect(jar.get("count")?.number()).toBe(42);
	});

	it("get().boolean() returns true for the literal string 'true'", () => {
		const jar = new CookieJar(req("optin=true; rejected=false"));
		expect(jar.get("optin")?.boolean()).toBe(true);
		expect(jar.get("rejected")?.boolean()).toBe(false);
	});
});

describe("CookieJar writes (Set-Cookie staging)", () => {
	it("set() stages a Set-Cookie header without options", () => {
		const jar = new CookieJar(req());
		jar.set("session", "abc");
		expect(jar.headers()).toEqual(["session=abc"]);
	});

	it("set() URL-encodes the value", () => {
		const jar = new CookieJar(req());
		jar.set("greeting", "hello world");
		expect(jar.headers()).toEqual(["greeting=hello%20world"]);
	});

	it("set() emits options in canonical order", () => {
		const jar = new CookieJar(req());
		const expires = new Date("2030-01-01T00:00:00Z");
		jar.set("session", "abc", {
			path: "/",
			domain: "example.test",
			expires,
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			maxAge: 3600,
		});
		const [header] = jar.headers();
		if (!header) throw new Error("expected at least one Set-Cookie header");
		expect(header).toContain("session=abc");
		expect(header).toContain("Path=/");
		expect(header).toContain("Domain=example.test");
		expect(header).toContain("Max-Age=3600");
		expect(header).toContain("Expires=Tue, 01 Jan 2030 00:00:00 GMT");
		expect(header).toContain("HttpOnly");
		expect(header).toContain("Secure");
		expect(header).toContain("SameSite=Lax");
	});

	it("delete() stages an Expires=epoch + Max-Age=0 header", () => {
		const jar = new CookieJar(req("session=abc"));
		jar.delete("session", { path: "/" });
		const [header] = jar.headers();
		if (!header) throw new Error("expected at least one Set-Cookie header");
		expect(header).toContain("session=");
		expect(header).toContain("Max-Age=0");
		expect(header).toContain("Expires=Thu, 01 Jan 1970");
		expect(header).toContain("Path=/");
	});

	it("a write reflects in subsequent reads on the same jar", () => {
		const jar = new CookieJar(req("existing=yes"));
		jar.set("fresh", "ok");
		expect(jar.get("fresh")?.value).toBe("ok");
		expect(jar.get("existing")?.value).toBe("yes");
	});

	it("delete() drops the value from subsequent reads", () => {
		const jar = new CookieJar(req("session=abc"));
		jar.delete("session");
		expect(jar.has("session")).toBe(false);
	});

	it("multiple writes accumulate in headers() in insertion order", () => {
		const jar = new CookieJar(req());
		jar.set("a", "1");
		jar.set("b", "2");
		jar.set("c", "3");
		expect(jar.headers()).toEqual(["a=1", "b=2", "c=3"]);
	});
});

describe("CookieJar with no request", () => {
	it("treats a missing request as empty cookies", () => {
		const jar = new CookieJar(undefined);
		expect(jar.has("anything")).toBe(false);
		expect(jar.get("anything")).toBeUndefined();
	});

	it("set/delete still stage headers when there is no request", () => {
		const jar = new CookieJar(undefined);
		jar.set("x", "y");
		expect(jar.headers()).toEqual(["x=y"]);
	});
});
