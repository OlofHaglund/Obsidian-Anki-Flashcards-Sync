import {defineConfig} from "vitest/config";
import {resolve} from "node:path";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
	resolve: {
		alias: {
			obsidian: resolve(__dirname, "test/mocks/obsidian.ts"),
		},
	},
});
