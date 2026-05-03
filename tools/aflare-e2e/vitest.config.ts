import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "e2e-cli",
		include: ["src/**/*.test.ts"],
	},
});
