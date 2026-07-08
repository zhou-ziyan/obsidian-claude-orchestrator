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
