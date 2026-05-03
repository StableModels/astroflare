import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "runtime",
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
