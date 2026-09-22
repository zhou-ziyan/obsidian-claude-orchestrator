/**
 * Everything that talks to (or builds argument lists for) the tmux binary.
 */
import { accessSync } from "fs";

/**
 * Parse `tmux ls` output and return session names that belong to a project.
 * A session belongs to a project if its name equals the project name
 * or matches `<project>-<N>`.
 *
 * Accepts both plain `tmux ls` output and the format-string variant
 * `tmux ls -F '#{session_name}:#{session_activity}'`.
 *
 * Returns `names` sorted alphabetically (for stable tab order) and
 * `mostRecent` — the session with the highest activity timestamp
 * (for the caller to reveal after creating all tabs).
 */
export function parseTmuxSessionsForProject(
	tmuxLsOutput: string,
	project: string,
): { names: string[]; mostRecent: string | null } {
	const re = new RegExp(`^${escapeRegExp(project)}(-\\d+)?$`);
	const sessions = parseAllTmuxSessions(tmuxLsOutput).filter((s) => re.test(s.name));
	// Sort alphabetically for stable tab order
	sessions.sort((a, b) => a.name.localeCompare(b.name));
	// Find most recently active
	let mostRecent: string | null = null;
	let maxActivity = -1;
	for (const s of sessions) {
		if (s.activity > maxActivity) {
			maxActivity = s.activity;
			mostRecent = s.name;
		}
	}
	return { names: sessions.map((s) => s.name), mostRecent };
}

/**
 * Return a compact timestamp string for stamping queue items.
 * Format: YYYY-MM-DD HH:MM
 */

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function execTmux(args: string[]): Promise<string> {
	const { execFile } = require("child_process") as typeof import("child_process");
	return new Promise((resolve, reject) => {
		execFile(findTmuxBinary(), args, (err, stdout) => {
			if (err) reject(err as Error);
			else resolve(stdout ?? "");
		});
	});
}

export function tmuxLs(): Promise<string> {
	return execTmux(["ls", "-F", "#{session_name}:#{session_activity}\t#{@co_vault}"]).catch(() => "");
}

/**
 * Parse `tmux ls -F` output into a flat list of session entries.
 */

/**
 * Parse `tmux ls -F` output into a flat list of session entries.
 */
export function parseAllTmuxSessions(
	tmuxLsOutput: string,
): { name: string; activity: number; vaultId?: string }[] {
	const sessions: { name: string; activity: number; vaultId?: string }[] = [];
	for (const line of tmuxLsOutput.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const tabIdx = trimmed.indexOf("\t");
		const nameActivity = tabIdx === -1 ? trimmed : trimmed.slice(0, tabIdx);
		const vaultRaw = tabIdx === -1 ? "" : trimmed.slice(tabIdx + 1).trim();
		const colonIdx = nameActivity.indexOf(":");
		if (colonIdx === -1) continue;
		const name = nameActivity.slice(0, colonIdx);
		const rest = nameActivity.slice(colonIdx + 1).trim();
		const activity = /^\d+$/.test(rest) ? Number(rest) : 0;
		sessions.push({ name, activity, vaultId: vaultRaw || undefined });
	}
	return sessions;
}

export const TMUX_SEARCH_PATHS = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"];

export const QUICK_REPLY_KEYS = ["1", "2", "Y", "{C-c}"] as const;

export function parseQuickReplyKeys(input: string): string[] {
	return input.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
}

function isTmuxKeySequence(key: string): boolean {
	return key.startsWith("{") && key.endsWith("}") && key.length > 2;
}

export function quickReplyLabel(key: string): string {
	if (!isTmuxKeySequence(key)) return key;
	const name = key.slice(1, -1);
	if (name.startsWith("C-")) return "^" + name.slice(2).toUpperCase();
	return name;
}

/**
 * Character encoding for tmux jobs.
 *
 * `copy-pipe`/`run-shell` commands are forked by the tmux *server*, so they
 * inherit the server's environment — never the pane's. A server started by
 * launchd (which is how the lighthouse agent starts one) carries no
 * LANG/LC_* at all, only `__CF_USER_TEXT_ENCODING=<uid>:0x0:0x0`; that `0x0`
 * is kCFStringEncodingMacRoman, and CoreFoundation tools fall back to it when
 * no POSIX locale is set. So the common `copy-pipe-and-cancel "pbcopy"`
 * binding decodes a UTF-8 selection as MacRoman and 我会 (e6 88 91 e4 bc 9a)
 * lands on the clipboard as Êàë‰ºö.
 *
 * Any POSIX locale variable overrides the CoreFoundation fallback, so the fix
 * is to make sure the tmux global environment declares a UTF-8 one.
 */
export const TMUX_FALLBACK_LOCALE = "en_US.UTF-8";

/** POSIX precedence for the character-encoding category, highest first. */
export const TMUX_LOCALE_VARS = ["LC_ALL", "LC_CTYPE", "LANG"] as const;

export function isUtf8Locale(value: string | null | undefined): boolean {
	return typeof value === "string" && /\.utf-?8$/i.test(value.trim());
}

/**
 * The UTF-8 locale to publish into tmux: reuse whatever the host already
 * declares so a zh_CN user keeps their messages, falling back to en_US.UTF-8
 * when the host declares none (Obsidian launched from Finder inherits no
 * locale at all).
 */
export function pickUtf8Locale(env: Record<string, string | undefined>): string {
	for (const name of TMUX_LOCALE_VARS) {
		const value = env[name];
		if (isUtf8Locale(value)) return value!.trim();
	}
	return TMUX_FALLBACK_LOCALE;
}

/**
 * Read one variable out of `tmux show-environment -g` output. tmux marks an
 * explicitly-unset variable as `-NAME`, which reads the same as absent here.
 */
export function parseTmuxGlobalEnvValue(output: string, name: string): string | null {
	const prefix = name + "=";
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
	}
	return null;
}

export function tmuxShowGlobalEnvArgs(): string[] {
	return ["show-environment", "-g"];
}

export function tmuxSetGlobalEnvArgs(name: string, value: string): string[] {
	return ["set-environment", "-g", name, value];
}

/**
 * tmux args that make the server's jobs decode UTF-8, or null when they
 * already do. Repairs the variable that actually governs decoding — fixing
 * LANG under an `LC_ALL=C` server would leave pbcopy mangling text — and
 * never overwrites a locale that is already UTF-8.
 */
export function tmuxLocaleRepair(
	globalEnvDump: string,
	hostEnv: Record<string, string | undefined>,
): string[] | null {
	for (const name of TMUX_LOCALE_VARS) {
		const value = parseTmuxGlobalEnvValue(globalEnvDump, name);
		if (value === null) continue;
		return isUtf8Locale(value) ? null : tmuxSetGlobalEnvArgs(name, pickUtf8Locale(hostEnv));
	}
	return tmuxSetGlobalEnvArgs("LANG", pickUtf8Locale(hostEnv));
}

/**
 * Publish a UTF-8 locale into a running tmux server's global environment.
 * Resolves false when nothing needed doing — including when no server is up
 * yet, since the plugin's own spawn env seeds a fresh server correctly.
 */
export async function ensureTmuxUtf8Locale(
	exec: (args: string[]) => Promise<string>,
	hostEnv: Record<string, string | undefined>,
): Promise<boolean> {
	let dump: string;
	try {
		dump = await exec(tmuxShowGlobalEnvArgs());
	} catch {
		return false;
	}
	const repair = tmuxLocaleRepair(dump, hostEnv);
	if (!repair) return false;
	try {
		await exec(repair);
		return true;
	} catch {
		return false;
	}
}

export function cancelCopyModeArgs(sessionName: string): string[] {
	return ["send-keys", "-t", sessionName, "-X", "cancel"];
}

/**
 * Full arg list for attach-or-create of a project session. `mouse on` makes
 * tmux request mouse reporting from xterm, so wheel events travel through the
 * PTY and tmux scrolls its own history (entering/leaving copy-mode itself) —
 * no external tmux processes per wheel tick. The `;`-chained set-options also
 * run when `-A` attaches to a pre-existing session.
 */

/**
 * Full arg list for attach-or-create of a project session. `mouse on` makes
 * tmux request mouse reporting from xterm, so wheel events travel through the
 * PTY and tmux scrolls its own history (entering/leaving copy-mode itself) —
 * no external tmux processes per wheel tick. The `;`-chained set-options also
 * run when `-A` attaches to a pre-existing session.
 */
export function buildTmuxSessionArgs(sessionName: string, vaultName: string): string[] {
	// window-size latest: PTY (client) resizes drive the window size. Also
	// heals sessions stuck in `manual` mode by older plugin versions whose
	// `resize-window -x -y` calls set the manual flag and froze client sizing.
	return ["new-session", "-A", "-s", sessionName,
		";", "set-option", "status", "off",
		";", "set-option", "mouse", "on",
		";", "set-option", "-w", "window-size", "latest",
		";", "set-option", "@co_vault", vaultName];
}

export function tmuxPageArgs(sessionName: string, direction: "up" | "down"): string[] {
	if (direction === "up") {
		// copy-mode -u pages up whether or not the pane is already in copy-mode;
		// -e auto-exits copy-mode when a later page-down reaches the bottom.
		return ["copy-mode", "-eu", "-t", sessionName];
	}
	return ["send-keys", "-t", sessionName, "-X", "page-down"];
}

/**
 * OSC 52 payload is `<selection>;<base64>`. tmux emits it when copy-mode
 * copies (set-clipboard external), letting drag-select land on the system
 * clipboard. Returns null for queries (`?`) and malformed payloads.
 */

export function buildQuickReplyTmuxArgs(
	sessionName: string,
	key: string,
): { textArgs: string[]; enterArgs: string[] } {
	if (isTmuxKeySequence(key)) {
		const tmuxKey = key.slice(1, -1);
		return {
			textArgs: ["send-keys", "-t", sessionName, tmuxKey],
			enterArgs: [],
		};
	}
	return {
		textArgs: ["send-keys", "-l", "-t", sessionName, "--", key],
		enterArgs: ["send-keys", "-t", sessionName, "Enter"],
	};
}

export function escapeLeadingBang(text: string): string {
	if (text.startsWith("!")) return " " + text;
	return text;
}

export function findTmuxBinary(exists?: (p: string) => boolean): string {
	const check = exists ?? ((p: string): boolean => {
		try { accessSync(p); return true; } catch { return false; }
	});
	for (const p of TMUX_SEARCH_PATHS) {
		if (check(p)) return p;
	}
	return "tmux";
}

/**
 * After editing a queue item, determine whether to auto-send.
 * Returns true when the queue has exactly 1 item — the one just edited —
 * so save-and-send can happen in one Enter press.
 */
