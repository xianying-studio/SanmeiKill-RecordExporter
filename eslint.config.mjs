import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import ts from "typescript-eslint";
import globals from "globals";

export default defineConfig(globalIgnores(["**/dist/", "**/release/", "**/node_modules/"]), js.configs.recommended, ts.configs.recommended, {
	files: ["**/*.ts"],
	rules: {
		"@typescript-eslint/no-require-imports": 0,
		"@typescript-eslint/no-unused-vars": 0,
		"@typescript-eslint/no-unused-expressions": 0,
		"@typescript-eslint/no-explicit-any": 0,
		"@typescript-eslint/no-empty-function": 0,
		"no-console": 0,
		"@typescript-eslint/ban-ts-comment": [
			"error",
			{
				"ts-ignore": false,
				"ts-nocheck": false,
			},
		],
		"prefer-const": 0,
		"no-redeclare": 0,
		"no-undef": 0,
		"no-empty": [
			"error",
			{
				allowEmptyCatch: true,
			},
		],
		"no-unused-vars": 0,
	},
	languageOptions: {
		ecmaVersion: 2022,
		sourceType: "module",
		globals: {
			...globals.browser,
			...globals.node,
		},
	},
});
