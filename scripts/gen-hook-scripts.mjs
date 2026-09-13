/**
 * Generates src/hook-scripts.generated.ts from the hook scripts in scripts/.
 *
 * The plugin has to ship its own hook scripts: BRAT and the release zip only
 * install main.js / manifest.json / styles.css, so a scripts/ directory next
 * to the plugin is never guaranteed to exist. Rather than keeping a hand-typed
 * second copy of each script (which drifts), the bundle's copy is generated
 * from the reviewed one and a unit test fails if the two diverge.
 *
 * The set of scripts is discovered, never hand-listed: a literal list silently
 * goes stale the moment someone adds a hook — which is exactly how the Codex
 * hook scripts were nearly shipped unbundled.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(repoRoot, "scripts");
/** Hook scripts are the `co-`-prefixed shell scripts; build helpers are not. */
const HOOK_SCRIPT_PATTERN = /^co-.*\.sh$/;
const OUT = join(repoRoot, "src", "hook-scripts.generated.ts");

const names = readdirSync(SCRIPTS_DIR)
	.filter((name) => HOOK_SCRIPT_PATTERN.test(name))
	.sort();

if (names.length === 0) {
	// Emitting an empty bundle would reintroduce the very bug this file exists
	// to prevent, silently. Fail the build instead.
	throw new Error(
		`gen-hook-scripts: no hook scripts matched ${HOOK_SCRIPT_PATTERN} in ${SCRIPTS_DIR}`,
	);
}

const entries = names.map((name) => {
	const source = readFileSync(join(SCRIPTS_DIR, name), "utf-8");
	return `\t${JSON.stringify(name)}: ${JSON.stringify(source)},`;
}).join("\n");

const out = `/**
 * GENERATED FILE — do not edit.
 * Run \`npm run gen:hooks\` after adding or changing anything under scripts/co-*.sh.
 * Source of truth: the scripts/ directory.
 */

export const HOOK_SCRIPT_SOURCES: Readonly<Record<string, string>> = {
${entries}
};
`;

writeFileSync(OUT, out, "utf-8");
console.warn(`gen-hook-scripts: wrote ${names.length} script(s) to ${OUT}`);
