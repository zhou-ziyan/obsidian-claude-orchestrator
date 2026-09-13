/**
 * The plugin ships its own Claude Code hook scripts.
 *
 * Two problems are solved here, and the second one dictates *where* the scripts
 * land:
 *
 * 1. Release channels install only `main.js` / `manifest.json` / `styles.css`,
 *    so a `scripts/` directory next to the plugin only ever existed on a dev
 *    checkout. Registering a hook there pointed at a file that could never run,
 *    and completion detection failed silently. The bundle therefore carries the
 *    script text (generated from `scripts/*.sh`) and writes it out at load time.
 *
 * 2. `~/.claude/settings.json` is a single global file shared by every vault.
 *    Writing the scripts under each plugin directory would give every vault its
 *    own valid-but-different path, so the vaults would keep rewriting the global
 *    config over each other on every load. Writing them to one fixed location
 *    instead means every vault computes the *same literal path*, the registered
 *    command already matches, and the write is skipped entirely.
 */
import { join } from "path";
import { HOOK_SCRIPT_SOURCES } from "./hook-scripts.generated.ts";

export { HOOK_SCRIPT_SOURCES };

/**
 * Fixed, vault-independent home for the materialized scripts. Deliberately not
 * under the plugin directory — see the note above about global settings churn.
 */
export const HOOK_SCRIPTS_HOME_DIR = ".claude-orchestrator";
export const HOOK_SCRIPTS_SUBDIR = "scripts";
export const STOP_HOOK_SCRIPT_NAME = "co-stop-hook.sh";
export const NOTIFICATION_HOOK_SCRIPT_NAME = "co-notification-hook.sh";
/** rwxr-xr-x — the hook is spawned by Claude Code, not sourced. */
export const HOOK_SCRIPT_MODE = 0o755;

/**
 * Filesystem port. Injected so materialization is unit-testable without
 * touching a real plugin directory.
 */
export interface HookScriptFs {
	ensureDir(dir: string): void;
	/** Current content, or null when the file is absent/unreadable. */
	readFile(path: string): string | null;
	writeFile(path: string, content: string): void;
	chmod(path: string, mode: number): void;
	isExecutableFile(path: string): boolean;
}

export interface MaterializedHookScripts {
	/**
	 * Script name to absolute path, one entry per bundled script. The value is
	 * null when that script could not be made runnable — engines name the
	 * scripts they need, so callers look them up by name rather than position.
	 */
	paths: Record<string, string | null>;
	/** Human-readable reasons, for a Notice. Empty on full success. */
	errors: string[];
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The one directory every vault materializes its hook scripts into. */
export function hookScriptsDir(homeDir: string): string {
	return join(homeDir, HOOK_SCRIPTS_HOME_DIR, HOOK_SCRIPTS_SUBDIR);
}

/**
 * Write every bundled hook script into {@link hookScriptsDir} and return the
 * paths that are actually runnable afterwards. A script that cannot be written
 * or is not executable afterwards yields `null` — callers must not register a
 * hook for it.
 */
export function materializeHookScripts(
	homeDir: string,
	fs: HookScriptFs,
): MaterializedHookScripts {
	const dir = hookScriptsDir(homeDir);
	const errors: string[] = [];
	const written: Record<string, string | null> = {};
	for (const name of Object.keys(HOOK_SCRIPT_SOURCES)) written[name] = null;

	try {
		fs.ensureDir(dir);
	} catch (error) {
		return { paths: written, errors: [`Could not create ${dir}: ${describeError(error)}`] };
	}

	for (const [name, source] of Object.entries(HOOK_SCRIPT_SOURCES)) {
		const path = join(dir, name);
		try {
			// Skip the write when content already matches: the plugin dir lives
			// inside the vault, and rewriting on every load churns file sync.
			if (fs.readFile(path) !== source) {
				fs.writeFile(path, source);
			}
			fs.chmod(path, HOOK_SCRIPT_MODE);
			if (fs.isExecutableFile(path)) {
				written[name] = path;
			} else {
				errors.push(`${name} is not executable after writing it to ${dir}`);
			}
		} catch (error) {
			errors.push(`Could not install ${name}: ${describeError(error)}`);
		}
	}

	return { paths: written, errors };
}
