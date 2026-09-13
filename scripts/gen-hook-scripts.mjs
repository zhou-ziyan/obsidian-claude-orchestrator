/**
 * Generates src/hook-scripts.generated.ts from the shell scripts in scripts/.
 *
 * The plugin has to ship its own hook scripts: BRAT and the release zip only
 * install main.js / manifest.json / styles.css, so a scripts/ directory next
 * to the plugin is never guaranteed to exist. Rather than keeping a hand-typed
 * second copy of each script (which drifts), the bundle's copy is generated
 * from the reviewed one and a unit test fails if the two diverge.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = ["co-stop-hook.sh", "co-notification-hook.sh"];
const OUT = join(repoRoot, "src", "hook-scripts.generated.ts");

const entries = SCRIPTS.map((name) => {
	const source = readFileSync(join(repoRoot, "scripts", name), "utf-8");
	return `\t${JSON.stringify(name)}: ${JSON.stringify(source)},`;
}).join("\n");

const out = `/**
 * GENERATED FILE — do not edit.
 * Run \`npm run gen:hooks\` after changing anything under scripts/*.sh.
 * Source of truth: scripts/co-stop-hook.sh, scripts/co-notification-hook.sh.
 */

export const HOOK_SCRIPT_SOURCES: Readonly<Record<string, string>> = {
${entries}
};
`;

writeFileSync(OUT, out, "utf-8");
console.warn(`gen-hook-scripts: wrote ${OUT}`);
