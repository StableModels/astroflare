import { describe, expect, it } from "vitest";
import { getEnvContext, getSecret, withEnvContext } from "./env.js";

describe("withEnvContext / getSecret", () => {
	it("returns undefined outside a withEnvContext scope", () => {
		expect(getSecret("X")).toBeUndefined();
		expect(getEnvContext()).toBeUndefined();
	});

	it("looks up a value bound by withEnvContext", () => {
		const result = withEnvContext({ DB_URL: "postgres://x" }, () => {
			return getSecret("DB_URL");
		});
		expect(result).toBe("postgres://x");
	});

	it("returns undefined for an unset name even inside a scope", () => {
		const result = withEnvContext({ A: "1" }, () => getSecret("MISSING"));
		expect(result).toBeUndefined();
	});

	it("propagates through awaits", async () => {
		const result = await withEnvContext({ TOKEN: "secret-1" }, async () => {
			await Promise.resolve();
			return getSecret("TOKEN");
		});
		expect(result).toBe("secret-1");
	});

	it("nested scopes shadow outer ones", () => {
		const result = withEnvContext({ X: "outer" }, () => {
			return withEnvContext({ X: "inner" }, () => {
				return getSecret("X");
			});
		});
		expect(result).toBe("inner");
	});

	it("getEnvContext returns the full bound record", () => {
		const result = withEnvContext({ A: "1", B: "2" }, () => getEnvContext());
		expect(result).toEqual({ A: "1", B: "2" });
	});

	it("scope ends after the callback returns", () => {
		withEnvContext({ X: "in" }, () => getSecret("X"));
		expect(getSecret("X")).toBeUndefined();
	});
});
