import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "site-workspace",
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
