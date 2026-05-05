import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "conformance",
		environment: "node",
		include: ["**/*.test.ts"],
	},
});
