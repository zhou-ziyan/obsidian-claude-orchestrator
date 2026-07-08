/**
 * Session manager list model: grouping live tmux sessions by project and
 * deriving per-card display state.
 */
import { projectFromSessionName } from "./projects.ts";
import type { ProjectRegistry } from "./projects.ts";
import { sessionDirPath, sessionNotePath } from "./session-note.ts";
import type { QueueMode, SessionStatus } from "./session-note.ts";

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

/**
 * Group a list of tmux sessions by project.
 * Sessions whose name doesn't match a project pattern go into the
 * "Unmanaged" group at the end.
 *
 * `openSessionNames` — sessions that have an open TerminalView panel.
 * `noteData` — map from session name to parsed note summary (if exists).
 */
export function groupSessionsByProject(
	allSessions: { name: string; activity: number; vaultId?: string }[],
	openSessionNames: Set<string>,
	noteData: Map<string, { queueCount: number; lastActivity: string | null; preview: string | null; displayName: string | null; status: SessionStatus; queueMode: QueueMode }>,
	projects: ProjectRegistry,
	projectsWithNotes?: Set<string>,
	vaultId?: string,
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
		} else if (!vaultId || !s.vaultId || s.vaultId === vaultId) {
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

export function sessionStatusDisplay(
	hasPanel: boolean,
	status: string,
): { cls: string; dataStatus: string } {
	if (!hasPanel) return { cls: "co-sm-status-dot", dataStatus: "off" };
	const dataStatus = status === "running" ? "running" : status === "waiting_for_user" ? "waiting_for_user" : "idle";
	return { cls: "co-sm-status-dot", dataStatus };
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

export function unregisterConfirmText(sessionCount: number): string {
	if (sessionCount <= 0) return "Confirm unregister?";
	const label = sessionCount === 1 ? "1 active session" : `${sessionCount} active sessions`;
	return `${label} will move to Unmanaged. Confirm unregister?`;
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
