const PROJECTS_DIR = "01_Projects";
const PROJECT_PATH_RE = new RegExp(`(?:^|/)${PROJECTS_DIR}/([^/]+)/`);

export { PROJECTS_DIR, PROJECT_PATH_RE };

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
	if (!existingNames.has(project)) return project;

	for (let i = 2; ; i++) {
		const candidate = `${project}-${i}`;
		if (!existingNames.has(candidate)) return candidate;
	}
}

/**
 * Extract the project folder name from a vault-relative note path.
 * Returns null if the path is not under 01_Projects/<name>/.
 */
export function resolveProjectFromPath(filePath: string): string | null {
	const match = filePath.match(PROJECT_PATH_RE);
	return match ? match[1] : null;
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
			const name = parts[0];
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

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Session note types and parsing ---

export type SessionStatus = "idle" | "running" | "waiting_for_user";

export interface HistoryItem {
	text: string;
	completed: boolean;
}

export interface SessionNote {
	session: string;
	status: SessionStatus;
	history: HistoryItem[];
	queue: string[];
}

/**
 * Vault-relative path for a session note.
 */
export function sessionNotePath(
	project: string,
	sessionName: string,
): string {
	return `${PROJECTS_DIR}/${project}/sessions/${sessionName}.md`;
}

/**
 * Create default markdown content for a new session note.
 */
export function createDefaultSessionNote(sessionName: string): string {
	return [
		"---",
		`session: ${sessionName}`,
		"status: idle",
		"---",
		"",
		"## History",
		"",
		"## Queue",
		"",
	].join("\n");
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
		history: [],
		queue: [],
	};

	const lines = markdown.split("\n");
	let i = 0;

	// Parse frontmatter
	if (lines[i]?.trim() === "---") {
		i++;
		while (i < lines.length && lines[i]?.trim() !== "---") {
			const line = lines[i].trim();
			const colonIdx = line.indexOf(":");
			if (colonIdx !== -1) {
				const key = line.slice(0, colonIdx).trim();
				const value = line.slice(colonIdx + 1).trim();
				if (key === "session") note.session = value;
				if (key === "status" && isSessionStatus(value))
					note.status = value;
			}
			i++;
		}
		if (i < lines.length) i++; // skip closing ---
	}

	// Parse body sections
	let currentSection: "none" | "history" | "queue" = "none";

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

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

		if (currentSection === "history" && trimmed.startsWith("- ")) {
			const checkMatch = trimmed.match(/^- \[([ xX])\] (.+)$/);
			if (checkMatch) {
				note.history.push({
					text: checkMatch[2],
					completed: checkMatch[1] !== " ",
				});
			} else {
				// Plain list item in history — treat as incomplete
				note.history.push({
					text: trimmed.slice(2),
					completed: false,
				});
			}
		} else if (currentSection === "queue" && trimmed.startsWith("- ")) {
			note.queue.push(trimmed.slice(2));
		}

		i++;
	}

	return note;
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
		"---",
		"",
		"## History",
	];

	for (const item of note.history) {
		const mark = item.completed ? "x" : " ";
		lines.push(`- [${mark}] ${item.text}`);
	}

	lines.push("");
	lines.push("## Queue");

	for (const item of note.queue) {
		lines.push(`- ${item}`);
	}

	lines.push("");
	return lines.join("\n");
}
