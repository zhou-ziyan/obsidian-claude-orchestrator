import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json',
						'tests/utils.test.ts',
					'tests/queue-engine.test.ts',
					'tests/hook-readiness.test.ts',
					'tests/stop-hook-watcher.test.ts',
					'tests/engines.test.ts',
					'tests/engine-usage.test.ts',
					'tests/sync-codex-config.test.ts',
					'tests/e2e-tmux.test.ts',
					'tests/e2e-dual-engine.test.ts',
					'tests/engine-cli.ts',
					'tests/worker-launch.test.ts',
					'tests/e2e-worker-launch.test.ts',
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	// Project-wide rule overrides for Electron plugin context
	{
		rules: {
			// We use require() for node-pty runtime loading (Electron prebuilt workaround)
			"@typescript-eslint/no-require-imports": "off",
			// Inline styles are needed for xterm.js layout and dynamic resize
			"obsidianmd/no-static-styles-assignment": "off",
			// Our UI strings are short labels — sentence case not always applicable
			"obsidianmd/ui/sentence-case": "off",
			"no-console": ["error", { allow: ["warn", "error", "debug"] }],
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"design-reference",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
