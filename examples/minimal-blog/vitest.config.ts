import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "minimal-blog",
		environment: "node",
		include: ["**/*.test.ts"],
	},
});
