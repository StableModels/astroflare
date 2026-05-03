import type { I18nConfig } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import { deriveLocale, getRelativeLocaleUrl } from "./i18n.js";

const PREFIX_OTHER: I18nConfig = {
	locales: ["en", "fr", "de"],
	defaultLocale: "en",
	routing: "pathname-prefix-other",
};

const PREFIX_DEFAULT: I18nConfig = {
	locales: ["en", "fr", "de"],
	defaultLocale: "en",
	routing: "prefix-default",
};

describe("deriveLocale", () => {
	it("returns the prefixed locale when present", () => {
		expect(deriveLocale("/fr/about", PREFIX_OTHER)).toBe("fr");
		expect(deriveLocale("/de/", PREFIX_OTHER)).toBe("de");
		expect(deriveLocale("/de", PREFIX_OTHER)).toBe("de");
	});

	it("falls back to the default locale when no prefix matches", () => {
		expect(deriveLocale("/about", PREFIX_OTHER)).toBe("en");
		expect(deriveLocale("/", PREFIX_OTHER)).toBe("en");
		expect(deriveLocale("/blog/post-1", PREFIX_OTHER)).toBe("en");
	});

	it("treats the default locale at the root as `defaultLocale` (prefix-other)", () => {
		expect(deriveLocale("/", PREFIX_OTHER)).toBe("en");
	});

	it("recognises the default locale prefix when configured (prefix-default)", () => {
		expect(deriveLocale("/en/about", PREFIX_DEFAULT)).toBe("en");
		expect(deriveLocale("/fr/about", PREFIX_DEFAULT)).toBe("fr");
	});

	it("ignores unknown locale-shaped prefixes", () => {
		expect(deriveLocale("/zzz/about", PREFIX_OTHER)).toBe("en");
	});
});

describe("getRelativeLocaleUrl", () => {
	it("prefixes non-default locales (prefix-other)", () => {
		expect(getRelativeLocaleUrl("fr", "/about", PREFIX_OTHER)).toBe("/fr/about");
		expect(getRelativeLocaleUrl("de", "/blog/x", PREFIX_OTHER)).toBe("/de/blog/x");
	});

	it("returns the bare path for the default locale (prefix-other)", () => {
		expect(getRelativeLocaleUrl("en", "/about", PREFIX_OTHER)).toBe("/about");
		expect(getRelativeLocaleUrl("en", "/", PREFIX_OTHER)).toBe("/");
	});

	it("prefixes every locale (prefix-default)", () => {
		expect(getRelativeLocaleUrl("en", "/about", PREFIX_DEFAULT)).toBe("/en/about");
		expect(getRelativeLocaleUrl("fr", "/about", PREFIX_DEFAULT)).toBe("/fr/about");
	});

	it("treats `/` specially so the locale stays alone (no `/fr//`)", () => {
		expect(getRelativeLocaleUrl("fr", "/", PREFIX_OTHER)).toBe("/fr");
		expect(getRelativeLocaleUrl("en", "/", PREFIX_DEFAULT)).toBe("/en");
	});

	it("normalises a missing leading slash", () => {
		expect(getRelativeLocaleUrl("fr", "about", PREFIX_OTHER)).toBe("/fr/about");
	});
});
