/**
 * Engine (provider) abstraction: everything that used to be hard-coded
 * "Claude Code" — how a session is launched and resumed, where its slash
 * commands come from, and how we learn a turn finished — expressed as a
 * capability descriptor so a second engine can be added without touching
 * the queue, note, or terminal layers.
 *
 * Two deliberate rules live here:
 *
 * 1. A session note with no `engine:` field is Claude. Every note written
 *    before dual-engine support predates the field, so absence must mean
 *    the engine those notes were actually driving.
 * 2. A note naming an engine we have no definition for fails safe: no
 *    launch command, no skill directories, no hooks, and manual queue mode
 *    only. Guessing "probably Claude" would type prompts into the wrong
 *    CLI, so an unrecognized value degrades instead of defaulting.
 */
import { BUILTIN_SLASH_COMMANDS, loadSlashCommands, mergeWithBuiltinCommands } from "./slash-commands.ts";
import type { SlashCommandEntry } from "./slash-commands.ts";
import type { QueueMode } from "./session-note.ts";

export type EngineId = "claude" | "codex";

export const ENGINE_IDS: readonly EngineId[] = ["claude", "codex"] as const;

export const DEFAULT_ENGINE_ID: EngineId = "claude";

export function isEngineId(value: unknown): value is EngineId {
	return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * How reliably the plugin learns that a turn ended.
 * - `hook`: the engine can call back into us (Claude Code's Stop hook), so
 *   auto-send and listen modes are trustworthy.
 * - `none`: no callback — only manual sending is honest.
 */
export type EngineCompletionSignal = "hook" | "none";

/**
 * What a hook tells us, independent of what the engine calls it. Engines
 * disagree on names for the same thing — Claude Code signals "needs your
 * input" with `Notification`, Codex with `PermissionRequest` — so consumers
 * key off the role and the definition supplies the engine-side event name.
 */
export type EngineHookRole = "turn-start" | "turn-end" | "waiting-for-input" | "interrupted";

export interface EngineHookEntry {
	role: EngineHookRole;
	/** Engine-side hook event name. */
	event: string;
	/** Script shipped in the plugin's `scripts/` directory. */
	script: string;
}

export interface EngineHookConfig {
	/** Path of the engine's settings file, relative to the user's home. */
	settingsSegments: readonly string[];
	entries: readonly EngineHookEntry[];
	/** Create the file when it is missing. True only for a file dedicated to
	 * hooks: conjuring a shared settings file the user never made (Claude's
	 * settings.json) would be presumptuous, but an absent hooks.json just
	 * means Codex has no hooks yet. */
	createIfMissing: boolean;
}

export interface EngineDefinition {
	id: EngineId;
	/** Human-facing name, e.g. in the session manager card. */
	label: string;
	/** Binary names to fall back on for a PATH lookup. */
	binaryNames: readonly string[];
	/** Absolute paths probed before the PATH fallback. `~` means home. */
	binarySearchPaths: readonly string[];
	/** Path segments, under each root, holding this engine's skills. */
	skillDirSegments: readonly string[];
	builtinSlashCommands: readonly SlashCommandEntry[];
	completionSignal: EngineCompletionSignal;
	hooks: EngineHookConfig | null;
}

export const CLAUDE_ENGINE: EngineDefinition = {
	id: "claude",
	label: "Claude Code",
	binaryNames: ["claude"],
	binarySearchPaths: ["~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
	skillDirSegments: [".claude", "skills"],
	builtinSlashCommands: BUILTIN_SLASH_COMMANDS,
	completionSignal: "hook",
	hooks: {
		settingsSegments: [".claude", "settings.json"],
		createIfMissing: false,
		entries: [
			{ role: "turn-start", event: "UserPromptSubmit", script: "co-prompt-submit-hook.sh" },
			{ role: "turn-end", event: "Stop", script: "co-stop-hook.sh" },
			{ role: "waiting-for-input", event: "Notification", script: "co-notification-hook.sh" },
		],
	},
};

/**
 * Codex CLI. Every value below traces to measured evidence from the
 * CodexProbe task against codex-cli 0.154.0-alpha.6.2, not to guesswork:
 *
 * - Hooks live in `$CODEX_HOME/hooks.json` and are structurally identical
 *   to Claude's `settings.json` hooks node, so auto-send is safe here too.
 * - Codex has no `Notification` event; `PermissionRequest` is what fires
 *   while the TUI blocks on an approval prompt.
 * - The payloads carry `last_assistant_message` directly and a Codex-shaped
 *   transcript, so the Claude hook scripts cannot be reused verbatim.
 * - `codex` on this machine is a shell function pointing into ChatGPT.app,
 *   not a binary on PATH — hence the search paths, with a real package
 *   install winning over the app bundle.
 * - The TUI and `exec` take different flag sets (`--skip-git-repo-check` is
 *   exec-only, `-a` is TUI-only), so only TUI flags appear here.
 * - The TUI's `/` menu is a fixed eight-entry built-in list (/model, /fast,
 *   /ide, /permissions, /keymap, /vim, /experimental, /approve). Skills never
 *   join it: `/<skill-name>` matches nothing. Codex reaches skills through a
 *   separate `$<skill-name>` picker instead, and loads them from
 *   $CODEX_HOME/skills, ~/.agents/skills and <project>/{.codex,.agents}/skills
 *   — never <project>/.claude/skills. Since this plugin's completion surface
 *   is keyed on `/`, listing skill directories here would offer Zoey commands
 *   that do nothing when typed, so both lists below stay empty on purpose.
 *   (Measured on 0.154.0-alpha.6.2, 2026-09-16; scripts/sync-codex-config.sh
 *   is what actually makes the vault's skills reachable from Codex.)
 */
export const CODEX_ENGINE: EngineDefinition = {
	id: "codex",
	label: "Codex",
	binaryNames: ["codex"],
	binarySearchPaths: [
		"/opt/homebrew/bin/codex",
		"/usr/local/bin/codex",
		"~/.local/bin/codex",
		"/Applications/ChatGPT.app/Contents/Resources/codex",
	],
	skillDirSegments: [],
	builtinSlashCommands: [],
	completionSignal: "hook",
	hooks: {
		settingsSegments: [".codex", "hooks.json"],
		createIfMissing: true,
		entries: [
			{ role: "turn-start", event: "UserPromptSubmit", script: "co-codex-prompt-submit-hook.sh" },
			{ role: "turn-end", event: "Stop", script: "co-codex-stop-hook.sh" },
			{ role: "waiting-for-input", event: "PermissionRequest", script: "co-codex-permission-hook.sh" },
			{ role: "interrupted", event: "Interrupt", script: "co-codex-interrupt-hook.sh" },
		],
	},
};

/**
 * Engines that currently have an implementation. An id listed in ENGINE_IDS
 * but absent here resolves to `unavailable` rather than silently to Claude.
 */
const ENGINE_DEFINITIONS: Partial<Record<EngineId, EngineDefinition>> = {
	claude: CLAUDE_ENGINE,
	codex: CODEX_ENGINE,
};

export function getEngineDefinition(id: EngineId): EngineDefinition | null {
	return ENGINE_DEFINITIONS[id] ?? null;
}

export function availableEngineIds(): EngineId[] {
	return ENGINE_IDS.filter((id) => ENGINE_DEFINITIONS[id] !== undefined);
}

export type EngineRefStatus = "default" | "known" | "unavailable";

export interface EngineRef {
	/** Recognized engine id, or null when the raw value matches none. */
	id: EngineId | null;
	/** Raw frontmatter value, kept verbatim for display and round-tripping. */
	raw: string | null;
	definition: EngineDefinition | null;
	status: EngineRefStatus;
}

/**
 * Resolve a session note's `engine:` value into a capability reference.
 * See the module header for the two rules this encodes.
 */
export function resolveEngineRef(raw?: string | null): EngineRef {
	const trimmed = (raw ?? "").trim();
	if (trimmed === "") {
		return { id: DEFAULT_ENGINE_ID, raw: null, definition: getEngineDefinition(DEFAULT_ENGINE_ID), status: "default" };
	}
	const normalized = trimmed.toLowerCase();
	if (isEngineId(normalized)) {
		const definition = getEngineDefinition(normalized);
		return definition
			? { id: normalized, raw: trimmed, definition, status: "known" }
			: { id: normalized, raw: trimmed, definition: null, status: "unavailable" };
	}
	return { id: null, raw: trimmed, definition: null, status: "unavailable" };
}

export function engineDisplayLabel(ref: EngineRef): string {
	if (ref.definition) return ref.definition.label;
	return `Unknown engine (${ref.raw ?? "?"})`;
}

/** Queue modes this engine can honor, most-conservative first. */
export function engineQueueModes(ref: EngineRef): QueueMode[] {
	if (ref.definition?.completionSignal === "hook") return ["manual", "listen", "auto"];
	return ["manual"];
}

export function engineSupportsAutoSend(ref: EngineRef): boolean {
	return engineQueueModes(ref).includes("auto");
}

/**
 * Clamp a stored queue mode to what the engine can actually deliver, so an
 * engine with no completion signal can never drive the queue by itself.
 */
export function effectiveQueueMode(ref: EngineRef, mode: QueueMode): QueueMode {
	return engineQueueModes(ref).includes(mode) ? mode : "manual";
}

function joinSegments(base: string, segments: readonly string[]): string {
	return [base.replace(/\/+$/, ""), ...segments].join("/");
}

function expandHome(path: string, home: string): string {
	return path.startsWith("~/") ? `${home.replace(/\/+$/, "")}/${path.slice(2)}` : path;
}

/**
 * First existing absolute path for the engine's binary, else its bare name
 * so a normal PATH lookup still applies. Mirrors `findTmuxBinary`.
 */
export function resolveEngineBinary(
	engine: EngineDefinition,
	home: string,
	exists: (path: string) => boolean,
): string {
	for (const candidate of engine.binarySearchPaths) {
		const full = expandHome(candidate, home);
		if (exists(full)) return full;
	}
	return engine.binaryNames[0] ?? engine.id;
}

/** Directories to scan for this engine's skills, one per root. */
export function engineSkillDirs(ref: EngineRef, roots: string[]): string[] {
	const definition = ref.definition;
	if (!definition || definition.skillDirSegments.length === 0) return [];
	return roots.filter((r) => r !== "").map((root) => joinSegments(root, definition.skillDirSegments));
}

/** Slash-command completions for this engine: its builtins plus disk skills. */
export function loadSlashCommandsFor(ref: EngineRef, roots: string[]): SlashCommandEntry[] {
	const definition = ref.definition;
	if (!definition || definition.builtinSlashCommands.length === 0) return [];
	const dirs = engineSkillDirs(ref, roots);
	if (dirs.length === 0) return mergeWithBuiltinCommands([], definition.builtinSlashCommands);
	return loadSlashCommands(dirs, definition.builtinSlashCommands);
}

/** Absolute path of the engine's settings file, or null if it has no hooks. */
export function engineSettingsPath(ref: EngineRef, home: string): string | null {
	const hooks = ref.definition?.hooks;
	if (!hooks) return null;
	return joinSegments(home, hooks.settingsSegments);
}

export function engineCreatesHookFile(ref: EngineRef): boolean {
	return ref.definition?.hooks?.createIfMissing ?? false;
}

export interface EngineHookRegistration {
	role: EngineHookRole;
	event: string;
	scriptName: string;
	scriptPath: string;
}

/** The hooks to register for this engine, resolved against the plugin's
 * `scripts/` directory. Empty when the engine has none. */
export function engineHookRegistrations(ref: EngineRef, scriptsDir: string): EngineHookRegistration[] {
	const hooks = ref.definition?.hooks;
	if (!hooks) return [];
	return hooks.entries.map((entry) => ({
		role: entry.role,
		event: entry.event,
		scriptName: entry.script,
		scriptPath: joinSegments(scriptsDir, [entry.script]),
	}));
}

// --- Selecting an engine for a session ---

/**
 * Engine for a session being created right now.
 *
 * Consulted only at creation. An existing session's engine comes from its
 * own note via `resolveEngineRef`, never from a default — otherwise changing
 * the default would retroactively relabel sessions the queue is still
 * driving as Claude.
 */
export function newSessionEngine(
	projectDefault: string | null | undefined,
	globalDefault: string | null | undefined,
): EngineId {
	for (const candidate of [projectDefault, globalDefault]) {
		const ref = resolveEngineRef(candidate);
		if (ref.status === "known" && ref.id) return ref.id;
	}
	return DEFAULT_ENGINE_ID;
}
