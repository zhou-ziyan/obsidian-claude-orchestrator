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

/** A command line to type into the session's shell. */
export interface EngineCommand {
	command: string;
	args: string[];
}

export interface EngineLaunchOptions {
	/** Model name for this session. Never hard-coded — it comes from the
	 * session note or project config, so new models need no code change. */
	model?: string;
}

export interface EngineResumeOptions extends EngineLaunchOptions {
	/** Provider-side conversation id, when one is known. Null/absent means
	 * "continue whatever ran last in this directory". */
	conversationId?: string | null;
}

/**
 * How reliably the plugin learns that a turn ended.
 * - `hook`: the engine can call back into us (Claude Code's Stop hook), so
 *   auto-send and listen modes are trustworthy.
 * - `none`: no callback — only manual sending is honest.
 */
export type EngineCompletionSignal = "hook" | "none";

export interface EngineHookEntry {
	/** Engine-side hook event name. */
	event: string;
	/** Script shipped in the plugin's `scripts/` directory. */
	script: string;
}

export interface EngineHookConfig {
	/** Path of the engine's settings file, relative to the user's home. */
	settingsSegments: readonly string[];
	entries: readonly EngineHookEntry[];
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
	buildLaunchCommand(opts?: EngineLaunchOptions): EngineCommand;
	/** Null when the engine has no resume story. */
	buildResumeCommand(opts?: EngineResumeOptions): EngineCommand | null;
}

function modelArgs(model: string | undefined, flag: string): string[] {
	const trimmed = model?.trim() ?? "";
	return trimmed ? [flag, trimmed] : [];
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
		entries: [
			{ event: "Stop", script: "co-stop-hook.sh" },
			{ event: "Notification", script: "co-notification-hook.sh" },
		],
	},
	buildLaunchCommand(opts) {
		return { command: "claude", args: modelArgs(opts?.model, "--model") };
	},
	buildResumeCommand(opts) {
		const id = opts?.conversationId?.trim() ?? "";
		const resume = id ? ["--resume", id] : ["--continue"];
		return { command: "claude", args: [...resume, ...modelArgs(opts?.model, "--model")] };
	},
};

/**
 * Engines that currently have an implementation. `codex` is a recognized
 * product id with no entry yet — until its adapter lands, notes naming it
 * resolve to `unavailable` rather than silently to Claude.
 */
const ENGINE_DEFINITIONS: Partial<Record<EngineId, EngineDefinition>> = {
	claude: CLAUDE_ENGINE,
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
	if (!definition) return [];
	return roots.filter((r) => r !== "").map((root) => joinSegments(root, definition.skillDirSegments));
}

/** Slash-command completions for this engine: its builtins plus disk skills. */
export function loadSlashCommandsFor(ref: EngineRef, roots: string[]): SlashCommandEntry[] {
	const definition = ref.definition;
	if (!definition) return [];
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

export interface EngineHookRegistration {
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
		event: entry.event,
		scriptName: entry.script,
		scriptPath: joinSegments(scriptsDir, [entry.script]),
	}));
}
