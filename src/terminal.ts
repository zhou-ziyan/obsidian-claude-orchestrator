/**
 * Terminal view support: xterm sizing/paging/theme, view-state
 * normalization, and the session-switch lifecycle guard.
 */

/**
 * Given a raw persisted view state, normalize project and sessionName
 * with backward-compat handling (old states that lack sessionName).
 */
export function normalizeViewState(state: unknown): {
	project: string | null;
	sessionName: string | null;
} {
	let project: string | null = null;
	let sessionName: string | null = null;

	if (state && typeof state === "object") {
		if ("project" in state) {
			const p = (state as Record<string, unknown>).project;
			project = typeof p === "string" ? p : null;
		}
		if ("sessionName" in state) {
			const s = (state as Record<string, unknown>).sessionName;
			sessionName = typeof s === "string" ? s : null;
		}
	}

	// Backward compat: old state without sessionName
	if (project && !sessionName) {
		sessionName = project;
	}

	return { project, sessionName };
}

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

/**
 * Minimum height (px) for the History panel's content area when resized.
 * Sized to show exactly one history item cleanly:
 *   item row = ceil(12px font * 1.4 line-height) + 4px padding = 21px
 *   content padding = 4px top + 4px bottom = 8px
 *   total = 29px
 */
export const HISTORY_ITEM_MIN_HEIGHT = 29;

/**
 * Copy a history item's text into the queue array, appending a fresh
 * timestamp. Strips any existing timestamp prefix so it doesn't double up.
 *
 * Returns the index where the item was inserted.
 */

export const TERMINAL_MIN_FIT_WIDTH = 50;

export const TERMINAL_MIN_FIT_HEIGHT = 10;

/**
 * Cols/rows for a host rect, or null when fitting must be skipped: cell
 * metrics not measured yet, or the host is hidden/collapsed (a zero-size
 * rect would otherwise resize xterm to 2x1 and mangle the alt screen while
 * the PTY stays at the real size).
 */

/**
 * Cols/rows for a host rect, or null when fitting must be skipped: cell
 * metrics not measured yet, or the host is hidden/collapsed (a zero-size
 * rect would otherwise resize xterm to 2x1 and mangle the alt screen while
 * the PTY stays at the real size).
 */
export function computeTerminalFit(
	rectWidth: number,
	rectHeight: number,
	cellWidth: number,
	cellHeight: number,
): { cols: number; rows: number } | null {
	if (cellWidth <= 0 || cellHeight <= 0) return null;
	if (rectWidth < TERMINAL_MIN_FIT_WIDTH || rectHeight < TERMINAL_MIN_FIT_HEIGHT) return null;
	return {
		cols: Math.max(2, Math.floor(rectWidth / cellWidth)),
		rows: Math.max(1, Math.floor(rectHeight / cellHeight)),
	};
}

export interface TerminalPageKeyResult {
	suppress: boolean;
	action: { target: "tmux" | "local"; direction: "up" | "down" } | null;
}

/** Empty Enter is a terminal keystroke; text Enter adds a Queue item. */
export function queueComposerEnterAction(value: string): "terminal-enter" | "add-to-queue" {
	return value.trim() === "" ? "terminal-enter" : "add-to-queue";
}

/**
 * Routing for PageUp/PageDown. xterm's local scrollback is empty while tmux
 * holds the alternate screen, so tmux sessions page via copy-mode instead.
 * `suppress` covers keyup/keypress too so xterm never writes the raw escape
 * sequence to the PTY, while `action` fires only once per press (keydown).
 */

/**
 * Routing for PageUp/PageDown. xterm's local scrollback is empty while tmux
 * holds the alternate screen, so tmux sessions page via copy-mode instead.
 * `suppress` covers keyup/keypress too so xterm never writes the raw escape
 * sequence to the PTY, while `action` fires only once per press (keydown).
 */
export function terminalPageKey(
	key: string,
	eventType: string,
	hasTmuxSession: boolean,
): TerminalPageKeyResult {
	if (key !== "PageUp" && key !== "PageDown") return { suppress: false, action: null };
	if (eventType !== "keydown") return { suppress: true, action: null };
	return {
		suppress: true,
		action: {
			target: hasTmuxSession ? "tmux" : "local",
			direction: key === "PageUp" ? "up" : "down",
		},
	};
}

/**
 * OSC 52 payload is `<selection>;<base64>`. tmux emits it when copy-mode
 * copies (set-clipboard external), letting drag-select land on the system
 * clipboard. Returns null for queries (`?`) and malformed payloads.
 */
export function parseOsc52Clipboard(data: string): string | null {
	const semi = data.indexOf(";");
	if (semi === -1) return null;
	const payload = data.slice(semi + 1);
	if (payload === "" || payload === "?") return null;
	if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
	return Buffer.from(payload, "base64").toString("utf8");
}

export type ThemeName = "terminal" | "obsidian";

export interface TerminalTheme {
	background: string;
	foreground: string;
	cursor?: string;
	black?: string;
	red?: string;
	green?: string;
	yellow?: string;
	blue?: string;
	magenta?: string;
	cyan?: string;
	white?: string;
	brightBlack?: string;
	brightRed?: string;
	brightGreen?: string;
	brightYellow?: string;
	brightBlue?: string;
	brightMagenta?: string;
	brightCyan?: string;
	brightWhite?: string;
}

// xterm's default ANSI palette assumes a dark background — ANSI white and
// bright white are near-#ffffff and vanish on a light background (Claude
// Code's TUI uses them heavily). Remap the 16 colors for readability on
// white; values follow VS Code's Light+ terminal palette.

// xterm's default ANSI palette assumes a dark background — ANSI white and
// bright white are near-#ffffff and vanish on a light background (Claude
// Code's TUI uses them heavily). Remap the 16 colors for readability on
// white; values follow VS Code's Light+ terminal palette.
const LIGHT_ANSI_PALETTE = {
	black: "#000000",
	red: "#cd3131",
	green: "#009400",
	yellow: "#949800",
	blue: "#0451a5",
	magenta: "#bc05bc",
	cyan: "#0598bc",
	white: "#555555",
	brightBlack: "#666666",
	brightRed: "#cd3131",
	brightGreen: "#14a814",
	brightYellow: "#8f9400",
	brightBlue: "#0451a5",
	brightMagenta: "#bc05bc",
	brightCyan: "#0598bc",
	brightWhite: "#a5a5a5",
} as const;

export function terminalTheme(theme: ThemeName, isDark = true): TerminalTheme {
	if (theme === "terminal") return { background: "#06090a", foreground: "#d6d7c9" };
	return isDark
		? { background: "#16161a", foreground: "#dcddde" }
		: { background: "#ffffff", foreground: "#1e1e1e", cursor: "#1e1e1e", ...LIGHT_ANSI_PALETTE };
}

export function migrateThemeName(value: unknown): ThemeName {
	if (value === "v1" || value === "terminal") return "terminal";
	if (value === "v2" || value === "obsidian") return "obsidian";
	return "obsidian";
}

export function computeDisplayText(project: string | null, sessionName: string | null): string {
	if (!sessionName || !project) return "Claude Orchestrator";
	const suffix = sessionName.slice(project.length);
	const match = suffix.match(/^-(\d+)$/);
	if (match) {
		return `${project} #${match[1]}`;
	}
	return project;
}

// --- PTY usage ---

// Display levels (session manager footer bar).

export interface SwitchResult {
	gen: number;
	needsSave: boolean;
	oldProject: string | null;
	oldSessionName: string | null;
}

export class SessionLifecycle {
	private _gen = 0;
	private _project: string | null = null;
	private _sessionName: string | null = null;
	private _dirty = false;
	private _pendingSave: Promise<void> | null = null;

	get gen(): number { return this._gen; }
	get project(): string | null { return this._project; }
	get sessionName(): string | null { return this._sessionName; }
	get dirty(): boolean { return this._dirty; }

	markDirty(): void { this._dirty = true; }
	markClean(): void { this._dirty = false; }

	beginSwitch(project: string | null, sessionName: string | null): SwitchResult {
		const oldProject = this._project;
		const oldSessionName = this._sessionName;
		const needsSave = this._dirty;
		this._gen++;
		this._project = project;
		this._sessionName = sessionName;
		this._dirty = false;
		return { gen: this._gen, needsSave, oldProject, oldSessionName };
	}

	isStale(capturedGen: number): boolean {
		return capturedGen !== this._gen;
	}

	captureTarget(): string | null {
		return this._sessionName;
	}

	trackSave(promise: Promise<void>): void {
		const tracked = promise.catch(() => {}).finally(() => {
			if (this._pendingSave === tracked) {
				this._pendingSave = null;
			}
		});
		this._pendingSave = tracked;
	}

	async flush(): Promise<void> {
		if (this._pendingSave) {
			await this._pendingSave;
		}
	}
}

export function countdownText(remaining: number): string {
	return `Auto-send in ${remaining}s`;
}
