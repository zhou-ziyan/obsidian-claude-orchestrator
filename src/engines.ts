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
import type { QueueMode, SessionNote } from "./session-note.ts";

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
	/** Resolved binary path, overriding the engine's default command name.
	 * Codex ships as a shell function pointing into ChatGPT.app rather than
	 * a binary on PATH, so the caller resolves it once and passes it here. */
	binary?: string;
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

/**
 * What a hook tells us, independent of what the engine calls it. Engines
 * disagree on names for the same thing — Claude Code signals "needs your
 * input" with `Notification`, Codex with `PermissionRequest` — so consumers
 * key off the role and the definition supplies the engine-side event name.
 */
export type EngineHookRole = "turn-end" | "waiting-for-input" | "interrupted";

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
	buildLaunchCommand(opts?: EngineLaunchOptions): EngineCommand;
	/** Null when the engine has no resume story. */
	buildResumeCommand(opts?: EngineResumeOptions): EngineCommand | null;
}

function modelArgs(model: string | undefined, flag: string): string[] {
	const trimmed = model?.trim() ?? "";
	return trimmed ? [flag, trimmed] : [];
}

function commandName(fallback: string, opts?: EngineLaunchOptions): string {
	const binary = opts?.binary?.trim() ?? "";
	return binary || fallback;
}

function shellQuote(token: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, "'\\''")}'`;
}

/** Render a command for typing into an interactive shell inside tmux. */
export function engineCommandLine(cmd: EngineCommand | null): string {
	if (!cmd) return "";
	return [cmd.command, ...cmd.args].map(shellQuote).join(" ");
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
			{ role: "turn-end", event: "Stop", script: "co-stop-hook.sh" },
			{ role: "waiting-for-input", event: "Notification", script: "co-notification-hook.sh" },
		],
	},
	buildLaunchCommand(opts) {
		return { command: commandName("claude", opts), args: modelArgs(opts?.model, "--model") };
	},
	buildResumeCommand(opts) {
		const id = opts?.conversationId?.trim() ?? "";
		const resume = id ? ["--resume", id] : ["--continue"];
		return { command: commandName("claude", opts), args: [...resume, ...modelArgs(opts?.model, "--model")] };
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
 * - No slash-command surface is verified for the TUI, so we claim none
 *   rather than showing Claude's list under a Codex session.
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
			{ role: "turn-end", event: "Stop", script: "co-codex-stop-hook.sh" },
			{ role: "waiting-for-input", event: "PermissionRequest", script: "co-codex-permission-hook.sh" },
			{ role: "interrupted", event: "Interrupt", script: "co-codex-interrupt-hook.sh" },
		],
	},
	buildLaunchCommand(opts) {
		return { command: commandName("codex", opts), args: modelArgs(opts?.model, "-m") };
	},
	buildResumeCommand(opts) {
		const id = opts?.conversationId?.trim() ?? "";
		const target = id ? [id] : ["--last"];
		return { command: commandName("codex", opts), args: ["resume", ...target, ...modelArgs(opts?.model, "-m")] };
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
 * Where a session's engine comes from, most specific first: the session
 * note, then the project's default, then the global default. A note that
 * names an unknown engine still fails safe — a project default must never
 * override an explicit (even if broken) per-session choice, or a switch
 * would silently target the wrong CLI.
 */
export function resolveSessionEngineRef(
	noteEngine: string | null | undefined,
	projectDefault: string | null | undefined,
	globalDefault: string | null | undefined,
): EngineRef {
	const note = (noteEngine ?? "").trim();
	if (note !== "") return resolveEngineRef(note);
	const project = (projectDefault ?? "").trim();
	if (project !== "") return resolveEngineRef(project);
	return resolveEngineRef(globalDefault ?? undefined);
}

// --- Switching a session between engines ---

export type EngineSwitchKind = "noop" | "retarget" | "new-session" | "unsupported";

export interface EngineSwitchPlan {
	kind: EngineSwitchKind;
	target: EngineId | null;
	/** Queue items that would need an explicit transfer afterwards. */
	pendingCount: number;
	/** Always false. A switch opens a sibling session; it never tears down
	 * the session the user may still have work running in. */
	killsSource: false;
	reason: string;
}

/**
 * Decide what switching this session to `target` should do.
 *
 * A tmux session is just a shell — the engine is whatever CLI is running
 * inside it, and the two engines' conversation ids are separate namespaces
 * that cannot be handed to each other. So once a session has actually run
 * something, switching means standing up a sibling session for the other
 * engine and leaving this one intact, rather than pretending the
 * conversation can move across. Only a session that has done nothing yet is
 * retargeted in place.
 */
export function planEngineSwitch(note: SessionNote, target: string): EngineSwitchPlan {
	const targetRef = resolveEngineRef(target);
	const pendingCount = note.queue.length;
	if (!targetRef.definition || targetRef.id === null) {
		return { kind: "unsupported", target: targetRef.id, pendingCount, killsSource: false,
			reason: `No definition for engine "${target}"` };
	}
	const current = resolveEngineRef(note.engine);
	if (current.id === targetRef.id) {
		return { kind: "noop", target: targetRef.id, pendingCount, killsSource: false,
			reason: `Already running ${targetRef.definition.label}` };
	}
	const hasRun = note.history.length > 0 || note.status === "running";
	if (!hasRun) {
		return { kind: "retarget", target: targetRef.id, pendingCount: 0, killsSource: false,
			reason: "Session has not run anything yet — switching in place" };
	}
	return { kind: "new-session", target: targetRef.id, pendingCount, killsSource: false,
		reason: `Existing work stays in this session; a new ${targetRef.definition.label} session will open alongside it` };
}

/**
 * Move pending queue items from one session note to another.
 *
 * Only queued work moves: history stays where it ran, and no claim is made
 * that conversation context carries across. Exactly-once falls out of
 * draining the source — a repeat call finds an empty queue and moves
 * nothing, so a double-click cannot duplicate a task. Returns how many
 * items moved.
 */
export function transferQueue(
	source: SessionNote,
	target: SessionNote,
	stamp: () => string,
): number {
	if (source === target || source.session === target.session) return 0;
	const moving = source.queue.splice(0, source.queue.length);
	if (moving.length === 0) return 0;
	target.queue.push(...moving);
	const line = `[${stamp()}] Handed off ${moving.length} queued item(s) → ${target.session}`;
	source.notes = source.notes ? `${source.notes}\n${line}` : line;
	return moving.length;
}
