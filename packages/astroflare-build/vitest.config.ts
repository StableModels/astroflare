import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "build",
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
