import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "test-utils",
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
