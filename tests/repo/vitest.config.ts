import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "repo",
		environment: "node",
		include: ["**/*.test.ts"],
	},
});
