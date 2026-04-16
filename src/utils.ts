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
 */
export function parseTmuxSessionsForProject(
	tmuxLsOutput: string,
	project: string,
): string[] {
	const re = new RegExp(`^${escapeRegExp(project)}(-\\d+)?:`);
	const sessions: string[] = [];
	for (const line of tmuxLsOutput.split("\n")) {
		const match = line.match(re);
		if (match) {
			// Session name is everything before the first ":"
			const name = line.split(":")[0];
			sessions.push(name);
		}
	}
	return sessions;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
