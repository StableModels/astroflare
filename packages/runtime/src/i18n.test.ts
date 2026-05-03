import type { I18nConfig } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import {
	deriveLocale,
	getAbsoluteLocaleUrl,
	getLocaleByPath,
	getRelativeLocaleUrl,
	parsePreferredLocales,
} from "./i18n.js";

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

describe("getLocaleByPath (alias for deriveLocale)", () => {
	it("returns the same value as deriveLocale", () => {
		expect(getLocaleByPath("/fr/about", PREFIX_OTHER)).toBe("fr");
		expect(getLocaleByPath("/about", PREFIX_OTHER)).toBe("en");
	});
});

describe("getAbsoluteLocaleUrl", () => {
	it("combines site origin + relative locale URL", () => {
		expect(getAbsoluteLocaleUrl("fr", "/about", PREFIX_OTHER, "https://app.example/")).toBe(
			"https://app.example/fr/about",
		);
		expect(getAbsoluteLocaleUrl("en", "/about", PREFIX_OTHER, "https://app.example")).toBe(
			"https://app.example/about",
		);
	});

	it("normalises a trailing-slash on site", () => {
		expect(getAbsoluteLocaleUrl("fr", "/", PREFIX_OTHER, "https://x.example/")).toBe(
			"https://x.example/fr",
		);
	});
});

describe("parsePreferredLocales", () => {
	const cfg = {
		locales: ["en", "fr", "de"],
		defaultLocale: "en",
	} satisfies I18nConfig;

	it("returns the ordered project-supported locales", () => {
		expect(parsePreferredLocales("fr,en;q=0.5,de;q=0.1", cfg)).toEqual(["fr", "en", "de"]);
	});

	it("filters out unsupported locales", () => {
		expect(parsePreferredLocales("ja,fr;q=0.9", cfg)).toEqual(["fr"]);
	});

	it("falls back to language-only prefix when full tag not supported", () => {
		// `fr-CA` isn't in `locales`; we accept `fr` as the base language.
		expect(parsePreferredLocales("fr-CA,en", cfg)).toEqual(["fr", "en"]);
	});

	it("returns empty for missing or wildcard headers", () => {
		expect(parsePreferredLocales(null, cfg)).toEqual([]);
		expect(parsePreferredLocales("", cfg)).toEqual([]);
		expect(parsePreferredLocales("*", cfg)).toEqual([]);
	});

	it("dedupes when both `fr-CA` and `fr` are present", () => {
		expect(parsePreferredLocales("fr-CA;q=0.9,fr;q=0.8", cfg)).toEqual(["fr"]);
	});

	it("respects q= ordering", () => {
		expect(parsePreferredLocales("de;q=0.1,en;q=0.9,fr", cfg)).toEqual(["fr", "en", "de"]);
	});
});
