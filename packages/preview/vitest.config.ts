import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "preview",
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
