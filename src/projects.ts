/**
 * Project registry: which vault folders map to which tmux project keys,
 * plus registry mutations and settings-shape migration.
 */

export interface ProjectConfig {
	vaultFolder: string;
	workingDirectory?: string;
	mainNote?: string;
	inactive?: boolean;
	/** Queue mode stamped on newly created sessions. Absent means use the
	 * user's global default. Existing session notes are never consulted here. */
	defaultQueueMode?: "manual" | "listen" | "auto";
	/** Engine new sessions in this project start on. Absent means fall
	 * through to the global default (which is Claude). */
	defaultEngine?: string;
	/** Permission policy for Manager-launched workers. Missing defaults to full access. */
	workerPermissions?: Partial<Record<"claude" | "codex", WorkerPermissionSetting>>;
}

export type WorkerPermissionMode = "prompt" | "bypass";
export type WorkerPermissionSetting = WorkerPermissionMode | "disabled";

export type ProjectRegistry = Record<string, ProjectConfig>;

/**
 * Given a project name and the set of session names already in use,
 * return the next available tmux session name.
 *
 * First terminal: "<project>" (base name).
 * Subsequent: "<project>-2", "<project>-3", ...
 */

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

/** Pick the next name while treating persisted session notes as occupied. */
export function generateSessionNameWithNotes(
	project: string,
	existingNames: Set<string>,
	noteFileNames: string[],
): string {
	const occupied = new Set(existingNames);
	for (const name of collectNoteNamesFromFiles(noteFileNames)) occupied.add(name);
	return generateSessionName(project, occupied);
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

export function migrateSettings(data: Record<string, unknown>): Record<string, unknown> {
	const out = { ...data };
	if ("queuePanel" in out && !("simpleMode" in out)) {
		out.simpleMode = !out.queuePanel;
		delete out.queuePanel;
	}
	if (out.defaultQueueMode !== "manual" && out.defaultQueueMode !== "listen" && out.defaultQueueMode !== "auto") {
		out.defaultQueueMode = "auto";
	}
	return out;
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
