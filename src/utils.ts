import { accessSync } from "fs";

export interface ProjectConfig {
	vaultFolder: string;
	workingDirectory?: string;
	mainNote?: string;
	inactive?: boolean;
}

export type ProjectRegistry = Record<string, ProjectConfig>;

/**
 * Given a project name and the set of session names already in use,
 * return the next available tmux session name.
 *
 * First terminal: "<project>" (base name).
 * Subsequent: "<project>-2", "<project>-3", ...
 */
export function generateSessionName(
	project: string,
	existingNames: Set<string>,
): string {
	for (let i = 1; ; i++) {
		const candidate = `${project}-${i}`;
		if (!existingNames.has(candidate)) return candidate;
	}
}

export function collectNoteNamesFromFiles(fileNames: string[]): Set<string> {
	const names = new Set<string>();
	for (const f of fileNames) {
		if (f.endsWith(".md")) {
			names.add(f.slice(0, -3));
		}
	}
	return names;
}

export function normalizeVaultFolder(raw: string): string {
	const trimmed = raw.replace(/^\/+|\/+$/g, "");
	return trimmed === "." ? "" : trimmed;
}

/**
 * Find the project whose vaultFolder is a prefix of the given file path.
 * If multiple projects match, the longest (most specific) folder wins.
 * An empty vaultFolder matches all files (vault root).
 */
export function resolveProjectFromPath(
	filePath: string,
	projects: ProjectRegistry,
): string | null {
	let bestMatch: string | null = null;
	let bestLen = -1;
	for (const [key, config] of Object.entries(projects)) {
		const folder = normalizeVaultFolder(config.vaultFolder);
		if (folder === "") {
			if (bestLen < 0) {
				bestMatch = key;
				bestLen = 0;
			}
		} else if (
			(filePath.startsWith(folder + "/") || filePath === folder) &&
			folder.length > bestLen
		) {
			bestMatch = key;
			bestLen = folder.length;
		}
	}
	return bestMatch;
}

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
export function parseTmuxSessionsForProject(
	tmuxLsOutput: string,
	project: string,
): { names: string[]; mostRecent: string | null } {
	const re = new RegExp(`^${escapeRegExp(project)}(-\\d+)?:`);
	const sessions: { name: string; activity: number }[] = [];
	for (const line of tmuxLsOutput.split("\n")) {
		const match = line.match(re);
		if (match) {
			const parts = line.split(":");
			const name = parts[0] ?? "";
			const lastPart = parts[parts.length - 1]?.trim();
			const activity =
				lastPart && /^\d+$/.test(lastPart) ? Number(lastPart) : 0;
			sessions.push({ name, activity });
		}
	}
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
export function nowStamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- tmux helpers ---

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
	return execTmux(["ls", "-F", "#{session_name}:#{session_activity}"]).catch(() => "");
}

/**
 * Parse `tmux ls -F` output into a flat list of session entries.
 */
export function parseAllTmuxSessions(
	tmuxLsOutput: string,
): { name: string; activity: number }[] {
	const sessions: { name: string; activity: number }[] = [];
	for (const line of tmuxLsOutput.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;
		const name = trimmed.slice(0, colonIdx);
		const rest = trimmed.slice(colonIdx + 1).trim();
		const activity = /^\d+$/.test(rest) ? Number(rest) : 0;
		sessions.push({ name, activity });
	}
	return sessions;
}

// --- Session Manager types ---

export interface SessionInfo {
	name: string;
	hasPanel: boolean;
	hasNote: boolean;
	queueCount: number;
	lastActivity: string | null;
	tmuxActivity: number;
	preview: string | null;
	displayName: string | null;
	status: SessionStatus;
	queueMode: QueueMode;
}

export interface SessionGroup {
	project: string;
	sessions: SessionInfo[];
	hasEverHadSession?: boolean;
}

/**
 * Derive the project key from a tmux session name by matching against
 * the project registry. Strips the `-N` suffix before checking.
 */
export function projectFromSessionName(
	sessionName: string,
	projects: ProjectRegistry,
): string | null {
	if (sessionName in projects) return sessionName;
	const base = sessionName.replace(/-\d+$/, "");
	return base in projects ? base : null;
}

export function sessionsMissingNotes(
	sessionNames: string[],
	projects: ProjectRegistry,
	existingNotePaths: Set<string>,
): { sessionName: string; notePath: string; dirPath: string }[] {
	const result: { sessionName: string; notePath: string; dirPath: string }[] = [];
	for (const name of sessionNames) {
		const project = projectFromSessionName(name, projects);
		if (!project) continue;
		const config = projects[project];
		if (!config) continue;
		const notePath = sessionNotePath(config.vaultFolder, name);
		if (!existingNotePaths.has(notePath)) {
			result.push({ sessionName: name, notePath, dirPath: sessionDirPath(config.vaultFolder) });
		}
	}
	return result;
}

/**
 * Group a list of tmux sessions by project.
 * Sessions whose name doesn't match a project pattern go into the
 * "Unmanaged" group at the end.
 *
 * `openSessionNames` — sessions that have an open TerminalView panel.
 * `noteData` — map from session name to parsed note summary (if exists).
 */
export function groupSessionsByProject(
	allSessions: { name: string; activity: number }[],
	openSessionNames: Set<string>,
	noteData: Map<string, { queueCount: number; lastActivity: string | null; preview: string | null; displayName: string | null; status: SessionStatus; queueMode: QueueMode }>,
	projects: ProjectRegistry,
	projectsWithNotes?: Set<string>,
): SessionGroup[] {
	const projectMap = new Map<string, SessionInfo[]>();
	const unmanaged: SessionInfo[] = [];

	for (const s of allSessions) {
		const project = projectFromSessionName(s.name, projects);
		const nd = noteData.get(s.name);
		const info: SessionInfo = {
			name: s.name,
			hasPanel: openSessionNames.has(s.name),
			hasNote: noteData.has(s.name),
			queueCount: nd?.queueCount ?? 0,
			lastActivity: nd?.lastActivity ?? null,
			tmuxActivity: s.activity,
			preview: nd?.preview ?? null,
			displayName: nd?.displayName ?? null,
			status: nd?.status ?? "idle",
			queueMode: nd?.queueMode ?? "manual",
		};

		if (project) {
			if (!projectMap.has(project)) projectMap.set(project, []);
			projectMap.get(project)!.push(info);
		} else {
			unmanaged.push(info);
		}
	}

	// Ensure registered projects with 0 sessions still appear
	for (const key of Object.keys(projects)) {
		if (!projectMap.has(key)) projectMap.set(key, []);
	}

	// Sort projects alphabetically, sessions within each project alphabetically
	const groups: SessionGroup[] = [];
	const sortedProjects = [...projectMap.keys()].sort();
	for (const project of sortedProjects) {
		const sessions = projectMap.get(project)!;
		sessions.sort((a, b) => a.name.localeCompare(b.name));
		const hasEver = sessions.length > 0 || (projectsWithNotes?.has(project) ?? false);
		groups.push({ project, sessions, hasEverHadSession: hasEver });
	}

	if (unmanaged.length > 0) {
		unmanaged.sort((a, b) => a.name.localeCompare(b.name));
		groups.push({ project: "Unmanaged", sessions: unmanaged });
	}

	return groups;
}

// --- Session note types and parsing ---

export type SessionStatus = "idle" | "running" | "waiting_for_user";

export type QueueMode = "manual" | "listen" | "auto";

export const QUEUE_MODES: readonly QueueMode[] = ["manual", "listen", "auto"] as const;

export function nextQueueMode(current: QueueMode): QueueMode {
	const idx = QUEUE_MODES.indexOf(current);
	return QUEUE_MODES[(idx + 1) % QUEUE_MODES.length]!;
}

export function queueModeLabel(mode: QueueMode): string {
	switch (mode) {
		case "manual": return "Manual";
		case "listen": return "Listen";
		case "auto": return "Auto";
	}
}

export function queueModeTooltip(mode: QueueMode): string {
	switch (mode) {
		case "manual": return "Manual: click Send next to send\nClick to switch → Listen";
		case "listen": return "Listen: will notify when Claude stops\nClick to switch → Auto";
		case "auto": return "Auto: auto-send next after Claude stops\nClick to switch → Manual";
	}
}

export type AutoSendAction = "send" | "notify" | "none";

export function autoSendAction(
	mode: QueueMode,
	stopReason: StopReason | null,
	queueLength: number,
): AutoSendAction {
	if (mode === "manual") return "none";
	if (stopReason === "asking") return "none";
	if (queueLength === 0) return "none";
	if (mode === "auto") return "send";
	if (mode === "listen") return "notify";
	return "none";
}

export const AUTO_SEND_COUNTDOWN_MS = 3000;

export function resolveClaudeIdle(prevIdle: boolean, noteStatus: string, externalModify: boolean): boolean {
	const noteIdle = noteStatus === "idle";
	if (externalModify && !prevIdle && noteIdle) return false;
	return noteIdle;
}

function isQueueMode(s: string): s is QueueMode {
	return s === "manual" || s === "listen" || s === "auto";
}

export interface HistoryItem {
	text: string;
	completed: boolean;
}

export interface SessionNote {
	session: string;
	status: SessionStatus;
	queueMode: QueueMode;
	displayName: string;
	summary: string;
	notes: string;
	history: HistoryItem[];
	queue: string[];
}

/**
 * Vault-relative path for a session note.
 * `vaultFolder` is the project's vault-relative folder path.
 * Empty string means vault root.
 */
export function sessionDirPath(vaultFolder: string): string {
	const normalized = normalizeVaultFolder(vaultFolder);
	return normalized ? `${normalized}/sessions` : "sessions";
}

export function sessionNotePath(
	vaultFolder: string,
	sessionName: string,
): string {
	return `${sessionDirPath(vaultFolder)}/${sessionName}.md`;
}

export function archiveSessionNotePath(
	vaultFolder: string,
	sessionName: string,
): string {
	return `${sessionDirPath(vaultFolder)}/archive-${sessionName}.md`;
}

export function renamedSessionNotePath(
	vaultFolder: string,
	oldSessionName: string,
	newSessionName: string,
): { oldPath: string; newPath: string } {
	const dir = sessionDirPath(vaultFolder);
	return {
		oldPath: `${dir}/${oldSessionName}.md`,
		newPath: `${dir}/${newSessionName}.md`,
	};
}

/**
 * Create default markdown content for a new session note.
 */
export function createDefaultSessionNote(sessionName: string, queueMode: QueueMode = "manual"): string {
	return [
		"---",
		`session: ${sessionName}`,
		"status: idle",
		`queueMode: ${queueMode}`,
		"---",
		"",
		"## Notes",
		"",
		"## History",
		"",
		"## Queue",
		"",
	].join("\n");
}

export function restoreSessionNote(
	archive: SessionNote,
	newSessionName: string,
	queueMode: QueueMode = "manual",
): SessionNote {
	return {
		session: newSessionName,
		status: "idle",
		queueMode,
		displayName: "",
		summary: "",
		notes: archive.notes,
		history: archive.history.map((h) => ({ ...h })),
		queue: [...archive.queue],
	};
}

/**
 * Parse a session note markdown string into a structured SessionNote.
 */
export function parseSessionNote(
	markdown: string,
	fallbackSession: string = "",
): SessionNote {
	const note: SessionNote = {
		session: fallbackSession,
		status: "idle",
		queueMode: "manual",
		displayName: "",
		summary: "",
		notes: "",
		history: [],
		queue: [],
	};

	const lines = markdown.split("\n");
	let i = 0;

	// Parse frontmatter
	if (lines[i]?.trim() === "---") {
		i++;
		while (i < lines.length && lines[i]?.trim() !== "---") {
			const line = lines[i]!.trim();
			const colonIdx = line.indexOf(":");
			if (colonIdx !== -1) {
				const key = line.slice(0, colonIdx).trim();
				const value = line.slice(colonIdx + 1).trim();
				if (key === "session") note.session = value;
				if (key === "status" && isSessionStatus(value))
					note.status = value;
				if (key === "queueMode" && isQueueMode(value))
					note.queueMode = value;
				if (key === "displayName" && value)
					note.displayName = value;
				if (key === "summary" && value)
					note.summary = value;
			}
			i++;
		}
		if (i < lines.length) i++; // skip closing ---
	}

	// Parse body sections
	let currentSection: "none" | "notes" | "history" | "queue" = "none";
	const notesLines: string[] = [];

	while (i < lines.length) {
		const line = lines[i]!;
		const trimmed = line.trim();

		if (trimmed.toLowerCase() === "## notes") {
			currentSection = "notes";
			i++;
			continue;
		}
		if (trimmed.toLowerCase() === "## history") {
			currentSection = "history";
			i++;
			continue;
		}
		if (trimmed.toLowerCase() === "## queue") {
			currentSection = "queue";
			i++;
			continue;
		}
		// Any other heading ends the current section
		if (trimmed.startsWith("## ")) {
			currentSection = "none";
			i++;
			continue;
		}

		if (currentSection === "notes") {
			notesLines.push(line);
			i++;
			continue;
		}

		// Items start with "- " (optionally with checkbox for history).
		// Continuation lines are indented (start with spaces/tabs) and
		// belong to the previous item.
		if ((currentSection === "history" || currentSection === "queue") && trimmed.startsWith("- ")) {
			const content = trimmed.slice(2);
			// Collect continuation lines: any line starting with 2+ spaces or tab
			// belongs to this item, regardless of its trimmed content (blank
			// lines, headings, etc. inside a multi-line item are preserved).
			const textLines = [currentSection === "history" ? parseHistoryFirstLine(content) : content];
			while (i + 1 < lines.length) {
				const nextRaw = lines[i + 1]!;
				if (!nextRaw.startsWith("  ") && !nextRaw.startsWith("\t")) break;
				textLines.push(nextRaw.trim());
				i++;
			}
			const fullText = textLines.join("\n");
			if (currentSection === "history") {
				const checkMatch = content.match(/^\[([ xX])\] /);
				note.history.push({
					text: fullText,
					completed: checkMatch ? checkMatch[1] !== " " : false,
				});
			} else {
				note.queue.push(fullText);
			}
		}

		i++;
	}

	// Trim leading/trailing blank lines from notes
	while (notesLines.length > 0 && notesLines[0]!.trim() === "") notesLines.shift();
	while (notesLines.length > 0 && notesLines[notesLines.length - 1]!.trim() === "") notesLines.pop();
	note.notes = notesLines.join("\n");

	return note;
}

function parseHistoryFirstLine(content: string): string {
	// Strip checkbox prefix "[x] " or "[ ] " from the first line
	return content.replace(/^\[([ xX])\] /, "");
}

function isSessionStatus(s: string): s is SessionStatus {
	return s === "idle" || s === "running" || s === "waiting_for_user";
}

/**
 * Serialize a SessionNote back to markdown.
 */
export function serializeSessionNote(note: SessionNote): string {
	const lines: string[] = [
		"---",
		`session: ${note.session}`,
		`status: ${note.status}`,
		`queueMode: ${note.queueMode}`,
	];
	if (note.displayName) lines.push(`displayName: ${note.displayName}`);
	if (note.summary) lines.push(`summary: ${note.summary}`);
	lines.push("---", "", "## Notes");

	if (note.notes) {
		lines.push(note.notes);
	}

	lines.push("", "## History");

	for (const item of note.history) {
		const mark = item.completed ? "x" : " ";
		const itemLines = item.text.split("\n");
		lines.push(`- [${mark}] ${itemLines[0]}`);
		for (let j = 1; j < itemLines.length; j++) {
			lines.push(`  ${itemLines[j]}`);
		}
	}

	lines.push("");
	lines.push("## Queue");

	for (const item of note.queue) {
		const itemLines = item.split("\n");
		lines.push(`- ${itemLines[0]}`);
		for (let j = 1; j < itemLines.length; j++) {
			lines.push(`  ${itemLines[j]}`);
		}
	}

	lines.push("");
	return lines.join("\n");
}

const TIMESTAMP_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /;

export function stripTimestamp(text: string): string {
	return text.replace(TIMESTAMP_PREFIX_RE, "");
}
const PREVIEW_SKIP_RE = /^(按照\s|按\s\S+\s执行|##+ |---\s*$)/;

export function extractSessionPreview(note: SessionNote): string | null {
	if (note.summary) return note.summary;

	const source = note.queue.length > 0
		? note.queue[note.queue.length - 1]!
		: note.history.length > 0
			? note.history[note.history.length - 1]!.text
			: null;
	if (!source) return null;
	const stripped = source.replace(TIMESTAMP_PREFIX_RE, "");
	const lines = stripped.split("\n");
	const meaningful = lines.find((l) => l.trim().length > 0 && !PREVIEW_SKIP_RE.test(l.trim()));
	return meaningful?.trim() ?? lines[0]!;
}

/**
 * Format a "YYYY-MM-DD HH:MM" timestamp as relative time.
 * Accepts an optional `now` parameter for testability.
 */
export function formatRelativeTime(stamp: string, now?: Date): string {
	const [datePart, timePart] = stamp.split(" ");
	if (!datePart || !timePart) return stamp;
	const dateParts = datePart.split("-").map(Number);
	const timeParts = timePart.split(":").map(Number);
	const y = dateParts[0] ?? 0, mo = dateParts[1] ?? 1, d = dateParts[2] ?? 1;
	const h = timeParts[0] ?? 0, mi = timeParts[1] ?? 0;
	const then = new Date(y, mo - 1, d, h, mi);
	const ref = now ?? new Date();
	const diffMs = ref.getTime() - then.getTime();
	if (diffMs < 0) return stamp;
	const diffMin = Math.floor(diffMs / 60_000);
	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	return `${diffDay}d ago`;
}

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
export function copyHistoryItemToQueue(text: string, queue: string[]): number {
	// Strip existing timestamp prefix "[YYYY-MM-DD HH:MM] " if present
	const body = text.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /, "");
	const stamped = `[${nowStamp()}] ${body}`;
	return queue.push(stamped) - 1;
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

export function sessionStatusDisplay(
	hasPanel: boolean,
	status: string,
): { cls: string; dataStatus: string } {
	if (!hasPanel) return { cls: "co-sm-status-dot", dataStatus: "off" };
	const dataStatus = status === "running" ? "running" : status === "waiting_for_user" ? "waiting_for_user" : "idle";
	return { cls: "co-sm-status-dot", dataStatus };
}

export type ThemeName = "terminal" | "obsidian";

export interface TerminalTheme {
	background: string;
	foreground: string;
	cursor?: string;
}

export function terminalTheme(theme: ThemeName): TerminalTheme {
	return theme === "terminal"
		? { background: "#06090a", foreground: "#d6d7c9" }
		: { background: "#16161a", foreground: "#dcddde" };
}

export function migrateThemeName(value: unknown): ThemeName {
	if (value === "v1" || value === "terminal") return "terminal";
	if (value === "v2" || value === "obsidian") return "obsidian";
	return "obsidian";
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
export function shouldAutoSendAfterEdit(queueLength: number): boolean {
	return queueLength === 1;
}

// --- Project registry mutations ---

export function validateProjectKey(
	key: string,
	existingKeys: Set<string>,
	currentKey?: string,
): string | null {
	const trimmed = key.trim();
	if (trimmed.length === 0) return "Project name cannot be empty";
	if (/[.:]/.test(trimmed)) return "Project name cannot contain '.' or ':' (tmux restriction)";
	if (trimmed === "Unmanaged") return "'Unmanaged' is a reserved name";
	if (existingKeys.has(trimmed) && trimmed !== currentKey) return "A project with this name already exists";
	return null;
}

export function addProject(
	registry: ProjectRegistry,
	key: string,
	config: ProjectConfig,
): ProjectRegistry {
	return { ...registry, [key]: config };
}

export function updateProjectConfig(
	registry: ProjectRegistry,
	key: string,
	updates: Partial<ProjectConfig>,
): ProjectRegistry {
	const existing = registry[key];
	if (!existing) return registry;
	return { ...registry, [key]: { ...existing, ...updates } };
}

export function removeProject(
	registry: ProjectRegistry,
	key: string,
): ProjectRegistry {
	if (!(key in registry)) return registry;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to exclude key
	const { [key]: _, ...rest } = registry;
	return rest;
}

export function restorableSessionNames(group: SessionGroup): string[] {
	return group.sessions.filter((s) => !s.hasPanel).map((s) => s.name);
}

export function applySortOrder<T extends { name: string }>(
	items: T[],
	order: string[],
): T[] {
	if (order.length === 0) return items;
	const orderMap = new Map(order.map((name, idx) => [name, idx]));
	return [...items].sort((a, b) => {
		const ai = orderMap.get(a.name) ?? Infinity;
		const bi = orderMap.get(b.name) ?? Infinity;
		if (ai !== bi) return ai - bi;
		return a.name.localeCompare(b.name);
	});
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

// --- PTY usage (dashboard) ---

export const PTY_THRESHOLD_WARNING = 0.7;
export const PTY_THRESHOLD_CRITICAL = 0.9;

export type PtyLevel = "ok" | "warning" | "critical";

export function parsePtyMax(sysctlOutput: string): number {
	const n = parseInt(sysctlOutput.trim(), 10);
	return isNaN(n) ? 0 : n;
}

export function ptyLevel(used: number, max: number): PtyLevel {
	if (max <= 0) return "ok";
	const ratio = used / max;
	if (ratio >= PTY_THRESHOLD_CRITICAL) return "critical";
	if (ratio >= PTY_THRESHOLD_WARNING) return "warning";
	return "ok";
}

export function countPtyEntries(devEntries: string[]): number {
	return devEntries.filter((name) => name.startsWith("ttys")).length;
}

export function getPtyUsage(): Promise<{ used: number; max: number }> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- child_process from require
	const { execFile } = require("child_process");
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- fs from require
	const fs = require("fs");

	return new Promise((resolve) => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call -- execFile is untyped from require
		execFile(
			"sysctl",
			["-n", "kern.tty.ptmx_max"],
			(err: Error | null, stdout: string) => {
				const max = err ? 0 : parsePtyMax(stdout);
				try {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- untyped fs
					const entries = fs.readdirSync("/dev") as string[];
					resolve({ used: countPtyEntries(entries), max });
				} catch {
					resolve({ used: 0, max });
				}
			},
		);
	});
}

// --- PTY budget (pre-spawn check) ---

export const PTY_WARNING_THRESHOLD = 0.9;
export const PTY_DEFAULT_MAX = 511;

export interface PtyUsage {
	used: number;
	max: number;
}

export type PtyStatus = "ok" | "warning" | "exhausted";

export function getPtyStatus(usage: PtyUsage): PtyStatus {
	if (usage.used >= usage.max) return "exhausted";
	if (usage.used > usage.max * PTY_WARNING_THRESHOLD) return "warning";
	return "ok";
}

export function ptyStatusMessage(usage: PtyUsage, status: PtyStatus): string {
	switch (status) {
		case "exhausted":
			return `PTY exhausted (${usage.used}/${usage.max}). Close unused terminals before creating new ones.`;
		case "warning":
			return `PTY usage high (${usage.used}/${usage.max}). Consider closing unused terminals.`;
		case "ok":
			return "";
	}
}

export function parsePtyUsed(wcOutput: string): number {
	const n = parseInt(wcOutput.trim(), 10);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function fetchPtyUsage(): Promise<PtyUsage> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- child_process from require
	const cp = require("child_process");
	const run = (cmd: string): Promise<string> =>
		new Promise((resolve) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			cp.exec(cmd, (_err: Error | null, stdout: string) => {
				resolve(stdout ?? "");
			});
		});
	return Promise.all([
		run("sysctl -n kern.tty.ptmx_max"),
		run("ls /dev/ttys* 2>/dev/null | wc -l"),
	]).then(([maxOut, usedOut]) => ({
		used: parsePtyUsed(usedOut),
		max: ptyMaxWithDefault(parsePtyMax(maxOut)),
	}));
}

export function ptyMaxWithDefault(parsedMax: number): number {
	return parsedMax > 0 ? parsedMax : PTY_DEFAULT_MAX;
}

// --- Idle session detection ---

export const IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function isSessionIdle(
	activityEpochSecs: number,
	nowMs?: number,
	thresholdMs?: number,
): boolean {
	if (activityEpochSecs <= 0) return false;
	const now = nowMs ?? Date.now();
	const threshold = thresholdMs ?? IDLE_THRESHOLD_MS;
	const activityMs = activityEpochSecs * 1000;
	return (now - activityMs) >= threshold;
}

// --- Stop hook signal ---

export const STOP_SIGNAL_DIR = "/tmp/co-stop";

export function stopSignalFileName(tmuxSession: string, timestamp: number): string {
	return `${timestamp}-${tmuxSession}.json`;
}

export type StopReason = "done" | "asking";

function isStopReason(s: string): s is StopReason {
	return s === "done" || s === "asking";
}

export interface StopSignal {
	tmuxSession: string;
	sessionId: string | null;
	transcriptPath: string | null;
	cwd: string | null;
	timestamp: number;
	stopReason: StopReason | null;
}

export function parseStopSignal(json: string): StopSignal | null {
	if (!json) return null;
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(json) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (typeof data.tmux_session !== "string") return null;
	if (typeof data.timestamp !== "number") return null;
	const rawReason = typeof data.stop_reason === "string" ? data.stop_reason : "";
	return {
		tmuxSession: data.tmux_session,
		sessionId: typeof data.session_id === "string" ? data.session_id : null,
		transcriptPath: typeof data.transcript_path === "string" ? data.transcript_path : null,
		cwd: typeof data.cwd === "string" ? data.cwd : null,
		timestamp: data.timestamp,
		stopReason: isStopReason(rawReason) ? rawReason : null,
	};
}

// --- Version bump ---

export function bumpPatchVersion(version: string): string {
	const parts = version.split(".").map(Number);
	parts[2] = (parts[2] ?? 0) + 1;
	return parts.join(".");
}

// --- Queue image parsing ---

export interface QueueItemSegment {
	type: "text" | "image";
	content: string;
}

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|svg|webp|bmp|avif)$/i;

const QUEUE_IMAGE_RE = /!\[\[([^\]]+)]]|!\[(?:[^\]]*)\]\(([^)]+)\)/g;

export function parseQueueItemSegments(text: string): QueueItemSegment[] {
	if (!text) return [];
	const segments: QueueItemSegment[] = [];
	let lastIndex = 0;

	for (const match of text.matchAll(QUEUE_IMAGE_RE)) {
		const ref = match[1] ?? match[2] ?? "";
		if (!IMAGE_EXTS.test(ref)) continue;

		if (match.index > lastIndex) {
			segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
		}
		segments.push({ type: "image", content: ref });
		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < text.length) {
		segments.push({ type: "text", content: text.slice(lastIndex) });
	}

	return segments;
}

// --- Done vs. Asking detection ---

export function classifyStopReason(text: string): StopReason {
	const tail = text.slice(-500);
	if (/[Yy]\/[Nn]/.test(tail)) return "asking";
	if (/\?\s*$/m.test(tail)) return "asking";
	return "done";
}

export function extractLastAssistantText(jsonlContent: string): string | null {
	const lines = jsonlContent.trimEnd().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type !== "assistant") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		if (!message) continue;
		const content = message.content as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(content)) continue;
		const texts = content
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string);
		if (texts.length === 0) return null;
		return texts.join("\n");
	}
	return null;
}

// --- Slash command autocomplete ---

export interface SlashCommandEntry {
	command: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandEntry[] = [
	{ command: "/clear", description: "Clear conversation history" },
	{ command: "/compact", description: "Compact conversation to save context" },
	{ command: "/cost", description: "Show token usage and cost" },
	{ command: "/doctor", description: "Check Claude Code health" },
	{ command: "/help", description: "Show available commands" },
	{ command: "/init", description: "Initialize CLAUDE.md in current directory" },
	{ command: "/login", description: "Sign in to your account" },
	{ command: "/logout", description: "Sign out of your account" },
	{ command: "/memory", description: "Edit CLAUDE.md memory files" },
	{ command: "/model", description: "Switch AI model" },
	{ command: "/review", description: "Review a pull request" },
];

export const SLASH_COMMANDS: readonly string[] = BUILTIN_SLASH_COMMANDS.map((e) => e.command);

export function parseSkillMd(content: string): { name: string; description: string } | null {
	if (!content || !content.startsWith("---")) return null;
	const endIdx = content.indexOf("---", 3);
	if (endIdx === -1) return null;
	const frontmatter = content.slice(3, endIdx);
	let name = "";
	let description = "";
	const lines = frontmatter.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value = line.slice(colonIdx + 1).trim();
		if (value === ">-" || value === ">" || value === "|" || value === "|-") {
			const parts: string[] = [];
			while (i + 1 < lines.length && /^\s/.test(lines[i + 1]!)) {
				i++;
				parts.push(lines[i]!.trim());
			}
			value = parts.join(" ");
		}
		if (key === "name") name = value;
		if (key === "description") {
			const useForIdx = value.indexOf("Use for:");
			description = useForIdx > 0 ? value.slice(0, useForIdx).trim() : value;
		}
	}
	return name ? { name, description } : null;
}

export function filterSlashCommands(input: string, commands?: readonly SlashCommandEntry[]): SlashCommandEntry[] {
	if (!input.startsWith("/")) return [];
	if (input !== input.trimEnd()) return [];
	const prefix = input.toLowerCase();
	const list = commands ?? BUILTIN_SLASH_COMMANDS;
	return list.filter((entry) => entry.command.toLowerCase().startsWith(prefix));
}

export function loadSlashCommands(skillDirs: string[]): SlashCommandEntry[] {
	const fs = require("fs") as typeof import("fs");
	const path = require("path") as typeof import("path");
	const skills: SlashCommandEntry[] = [];

	for (const dir of skillDirs) {
		let entries: string[];
		try { entries = fs.readdirSync(dir); } catch { continue; }
		for (const name of entries) {
			const skillDir = path.join(dir, name);
			let content: string | undefined;
			for (const fn of ["SKILL.md", "skill.md"]) {
				try { content = fs.readFileSync(path.join(skillDir, fn), "utf8"); break; } catch { /* try next */ }
			}
			if (!content) continue;
			const parsed = parseSkillMd(content);
			if (parsed) {
				skills.push({ command: `/${parsed.name}`, description: parsed.description });
			}
		}
	}

	return mergeWithBuiltinCommands(skills);
}

export function mergeWithBuiltinCommands(skills: SlashCommandEntry[]): SlashCommandEntry[] {
	const merged = new Map<string, SlashCommandEntry>();
	for (const entry of BUILTIN_SLASH_COMMANDS) {
		merged.set(entry.command, entry);
	}
	for (const entry of skills) {
		if (!merged.has(entry.command)) {
			merged.set(entry.command, entry);
		}
	}
	return [...merged.values()].sort((a, b) => a.command.localeCompare(b.command));
}

export function migrateSettings(data: Record<string, unknown>): Record<string, unknown> {
	const out = { ...data };
	if ("queuePanel" in out && !("simpleMode" in out)) {
		out.simpleMode = !out.queuePanel;
		delete out.queuePanel;
	}
	return out;
}

// --- Stop hook auto-registration ---

interface ClaudeHookEntry {
	type: string;
	command: string;
	timeout?: number;
}

interface ClaudeHookMatcher {
	matcher: string;
	hooks: ClaudeHookEntry[];
}

export function ensureStopHookConfig(
	settingsJson: string,
	scriptPath: string,
): { updated: boolean; content: string } {
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(settingsJson) as Record<string, unknown>;
	} catch {
		return { updated: false, content: settingsJson };
	}

	const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
	const stopMatchers = (hooks.Stop ?? []) as ClaudeHookMatcher[];

	const alreadyRegistered = stopMatchers.some((m) =>
		m.hooks?.some((h) => h.command?.includes("co-stop-hook.sh")),
	);

	if (alreadyRegistered) {
		return { updated: false, content: settingsJson };
	}

	stopMatchers.push({
		matcher: "*",
		hooks: [{
			type: "command",
			command: scriptPath,
			timeout: 10,
		}],
	});

	hooks.Stop = stopMatchers;
	settings.hooks = hooks;

	return {
		updated: true,
		content: JSON.stringify(settings, null, 2),
	};
}

export function handleTerminalScrollKey(
	key: string,
	scrollPages: (n: number) => void,
): boolean {
	if (key === "PageUp") { scrollPages(-1); return false; }
	if (key === "PageDown") { scrollPages(+1); return false; }
	return true;
}

export const WHEEL_LINES_PER_PAGE = 10;

export function wheelDeltaToLines(deltaY: number, deltaMode: number): number {
	if (deltaMode === 1) return deltaY;
	if (deltaMode === 2) return deltaY * WHEEL_LINES_PER_PAGE;
	const lines = Math.trunc(deltaY / 20);
	return lines === 0 ? (deltaY > 0 ? 1 : deltaY < 0 ? -1 : 0) : lines;
}

export type AcKeyAction = "accept" | "close" | "next" | "prev" | null;

export function classifyAcKey(key: string, shiftKey: boolean): AcKeyAction {
	if (key === "ArrowDown") return "next";
	if (key === "ArrowUp") return "prev";
	if (key === "Escape") return "close";
	if ((key === "Enter" || key === "Tab" || key === "ArrowRight") && !shiftKey) return "accept";
	return null;
}

/**
 * Collect all session note file paths for every registered project.
 * Returns vault-relative paths like "01_Projects/Foo/sessions/Foo-1.md".
 */
export function allSessionNotePaths(
	projects: ProjectRegistry,
	sessionNames: string[],
): string[] {
	const paths: string[] = [];
	for (const config of Object.values(projects)) {
		const dir = sessionDirPath(config.vaultFolder);
		for (const name of sessionNames) {
			paths.push(`${dir}/${name}.md`);
		}
	}
	return paths;
}

export function pickRecoverySession(
	tmuxSessions: { name: string; activity: number }[],
	projects: ProjectRegistry,
	claimedNames: Set<string>,
): { project: string; sessionName: string } | null {
	let best: { project: string; sessionName: string; activity: number } | null = null;
	for (const s of tmuxSessions) {
		if (claimedNames.has(s.name)) continue;
		const project = projectFromSessionName(s.name, projects);
		if (!project) continue;
		if (!best || s.activity > best.activity) {
			best = { project, sessionName: s.name, activity: s.activity };
		}
	}
	return best ? { project: best.project, sessionName: best.sessionName } : null;
}

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

export function unregisterConfirmText(sessionCount: number): string {
	if (sessionCount <= 0) return "Confirm unregister?";
	const label = sessionCount === 1 ? "1 active session" : `${sessionCount} active sessions`;
	return `${label} will move to Unmanaged. Confirm unregister?`;
}

// --- Extracted view helpers (pure functions from view.ts / session-manager-view.ts) ---

const ITEM_TS_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] /;

export function extractTimestamp(text: string): { stamp: string | null; body: string } {
	const m = text.match(ITEM_TS_RE);
	if (m && m[1]) {
		const timeOnly = m[1].split(" ")[1] ?? m[1];
		return { stamp: timeOnly, body: text.slice(m[0]?.length ?? 0) };
	}
	return { stamp: null, body: text };
}

const ACTIVITY_TS_RE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/;

export function findLastActivityTimestamp(
	historyTexts: string[],
	queueTexts: string[],
): string | null {
	const allItems = [...historyTexts, ...queueTexts];
	for (let i = allItems.length - 1; i >= 0; i--) {
		const m = allItems[i]?.match(ACTIVITY_TS_RE);
		if (m?.[1]) return m[1];
	}
	return null;
}

export function sessionDisplayLabel(
	sessionName: string,
	displayName?: string | null,
): string {
	if (displayName) return displayName;
	return sessionName.replace(/-(\d+)$/, " #$1");
}

export function splitActiveInactive(
	groups: SessionGroup[],
	projects: ProjectRegistry,
): { active: SessionGroup[]; inactive: SessionGroup[] } {
	const active: SessionGroup[] = [];
	const inactive: SessionGroup[] = [];
	for (const group of groups) {
		const config = projects[group.project];
		if (group.project === "Unmanaged" || !config?.inactive) {
			active.push(group);
		} else {
			inactive.push(group);
		}
	}
	return { active, inactive };
}

export function computeSessionCwd(
	workingDirectory: string | undefined,
	vaultFolder: string | undefined,
	basePath: string | null,
	homedir: string,
): string {
	if (workingDirectory) return workingDirectory;
	if (basePath !== null) {
		return vaultFolder ? `${basePath}/${vaultFolder}` : basePath;
	}
	return homedir;
}

export function ptyBarPercent(used: number, max: number): number {
	if (max <= 0) return 0;
	return Math.min(100, Math.round((used / max) * 100));
}

export function countdownText(remaining: number): string {
	return `Auto-send in ${remaining}s`;
}

export function deriveStatusFromStop(
	stopReason: StopReason | null,
): { claudeIdle: boolean; status: SessionStatus } {
	const claudeIdle = stopReason !== "asking";
	const status: SessionStatus = stopReason === "asking" ? "waiting_for_user" : "idle";
	return { claudeIdle, status };
}

export function markLastHistoryDone(
	history: HistoryItem[],
	stopReason: StopReason | null,
): boolean {
	if (stopReason !== "done") return false;
	const last = history[history.length - 1];
	if (last && !last.completed) {
		last.completed = true;
		return true;
	}
	return false;
}

export function summarizeSessionNote(note: SessionNote): {
	queueCount: number;
	lastActivity: string | null;
	preview: string | null;
	displayName: string | null;
	status: SessionStatus;
	queueMode: QueueMode;
} {
	return {
		queueCount: note.queue.length,
		lastActivity: findLastActivityTimestamp(
			note.history.map((h) => h.text),
			note.queue,
		),
		preview: extractSessionPreview(note),
		displayName: note.displayName || null,
		status: note.status,
		queueMode: note.queueMode,
	};
}

export function notifyQueueMessage(prefix: string, queueLength: number): string {
	return `${prefix} — ${queueLength} item(s) in queue`;
}

export function prepareQueueTaskText(rawTask: string): string {
	return escapeLeadingBang(stripTimestamp(rawTask));
}
