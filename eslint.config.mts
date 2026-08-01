import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				createEl: "readonly",
				createDiv: "readonly",
				createSpan: "readonly",
				createFragment: "readonly",
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	globalIgnores([
		"node_modules",
		"dist",
		"test",
		"esbuild.config.mjs",
		"eslint.config.js",
		"vitest.config.ts",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
