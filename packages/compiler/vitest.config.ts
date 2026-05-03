import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "compiler",
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
