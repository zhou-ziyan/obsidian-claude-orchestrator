/**
 * Claude Code hook integration: parsing/dispatching stop-signal files the
 * hook scripts drop in /tmp/co-stop, and auto-registering those hooks in
 * ~/.claude/settings.json.
 */
import { projectFromSessionName } from "./projects.ts";
import type { ProjectRegistry } from "./projects.ts";

export const STOP_SIGNAL_DIR = "/tmp/co-stop";

export function stopSignalFileName(tmuxSession: string, timestamp: number): string {
	return `${timestamp}-${tmuxSession}.json`;
}

/**
 * Normalized turn outcome, shared by every engine:
 * - `started` — a prompt was submitted; every send path is disarmed.
 * - `done`    — the turn finished; the queue may advance after settling.
 * - `asking`  — the agent is blocked on the user (Claude `Notification`,
 *               Codex `PermissionRequest`).
 * - `error`   — the turn was aborted (Codex `Interrupt`). Not a completion:
 *               the queue must not advance and nothing is marked done.
 */
export type StopReason = "started" | "done" | "asking" | "error";

function isStopReason(s: string): s is StopReason {
	return s === "started" || s === "done" || s === "asking" || s === "error";
}

export interface StopSignal {
	tmuxSession: string;
	sessionId: string | null;
	transcriptPath: string | null;
	cwd: string | null;
	timestamp: number;
	stopReason: StopReason | null;
	/** Vault name the session belongs to (from tmux @co_vault); null on
	 * signals written by older hook scripts. */
	vault: string | null;
	/** Engine that emitted this signal. Signals from the original hook
	 * scripts carry no provider field and are Claude's by construction. */
	provider: string;
	/** Per-turn id. Codex supplies one; Claude does not. */
	turnId: string | null;
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
		vault: typeof data.vault === "string" && data.vault !== "" ? data.vault : null,
		provider: typeof data.provider === "string" && data.provider !== "" ? data.provider : "claude",
		turnId: typeof data.turn_id === "string" && data.turn_id !== "" ? data.turn_id : null,
	};
}

/**
 * Identity of one turn-level event. Codex session ids are UUIDv7 and
 * Claude's are UUIDv4 — both plain 36-character UUID literals, so the two
 * namespaces can only be separated by the explicit provider field, never by
 * sniffing the id's shape.
 */
export function stopSignalKey(signal: StopSignal): string {
	// Codex supplies a real per-turn id. Do not include the hook file's wall
	// clock in that identity: the same event can be delivered twice with a
	// different timestamp by watch + poll or duplicate hook registration.
	const eventClock = signal.turnId ? "" : String(signal.timestamp);
	return [
		signal.provider,
		signal.tmuxSession,
		signal.sessionId ?? "",
		signal.turnId ?? "",
		signal.stopReason ?? "",
		eventClock,
	].join("|");
}

const DEFAULT_LEDGER_SIZE = 200;

/**
 * Guards the signal pipeline against redelivery and out-of-order arrival.
 * The signal directory is polled as well as watched, and hooks can fire
 * more than once, so a turn-end must be actioned exactly once — otherwise
 * one stop advances the queue twice.
 *
 * Lateness is tracked per (provider, tmux session): a signal older than one
 * already processed for that pair is dropped, while an unrelated session or
 * the other engine on the same session is unaffected.
 */
export class StopSignalLedger {
	private seen = new Set<string>();
	private order: string[] = [];
	private latest = new Map<string, number>();
	private latestKind = new Map<string, number>();
	private maxEntries: number;
	private debounceSeconds: number;

	constructor(maxEntries: number = DEFAULT_LEDGER_SIZE, debounceSeconds: number = 2) {
		this.maxEntries = Math.max(1, maxEntries);
		this.debounceSeconds = Math.max(0, debounceSeconds);
	}

	get size(): number {
		return this.seen.size;
	}

	accept(signal: StopSignal): boolean {
		const key = stopSignalKey(signal);
		if (this.seen.has(key)) return false;

		const lane = `${signal.provider}|${signal.tmuxSession}`;
		const newest = this.latest.get(lane);
		if (newest !== undefined && signal.timestamp < newest) return false;
		if (signal.stopReason === "started") {
			for (const reason of ["done", "asking", "error"]) {
				this.latestKind.delete(`${lane}|${reason}`);
			}
		}
		// Claude has no turn id. Collapse same-kind hook bursts in a short
		// window, while started → done remains distinct and legitimate.
		const kindLane = `${lane}|${signal.stopReason ?? ""}`;
		const newestKind = this.latestKind.get(kindLane);
		if (!signal.turnId && newestKind !== undefined
			&& signal.timestamp >= newestKind
			&& signal.timestamp - newestKind <= this.debounceSeconds) return false;

		this.seen.add(key);
		this.order.push(key);
		this.latest.set(lane, Math.max(newest ?? 0, signal.timestamp));
		this.latestKind.set(kindLane, Math.max(newestKind ?? 0, signal.timestamp));
		while (this.order.length > this.maxEntries) {
			const evicted = this.order.shift();
			if (evicted !== undefined) this.seen.delete(evicted);
		}
		return true;
	}
}

/** Signals that no vault claims are cleaned up after this TTL. */
export const STOP_SIGNAL_TTL_MS = 5 * 60 * 1000;

export function isStaleSignalFile(mtimeMs: number, nowMs: number): boolean {
	return nowMs - mtimeMs > STOP_SIGNAL_TTL_MS;
}

export interface StopSignalDisposition {
	action: "consume" | "ignore" | "discard";
	project: string | null;
}

/**
 * Decide what a vault's watcher should do with a signal file. The signal
 * directory is shared by all vaults, so a watcher must never delete a file
 * another vault's plugin may still need:
 * - consume: ours (vault tag matches, or legacy untagged with a known
 *   project) — dispatch and delete.
 * - ignore: someone else's (other vault tag, or untagged with no project
 *   match here) — leave the file for its owner; TTL cleanup catches strays.
 * - discard: garbage or provably unclaimable — delete without dispatching.
 */
export function stopSignalDisposition(
	signal: StopSignal | null,
	myVault: string,
	projects: ProjectRegistry,
): StopSignalDisposition {
	if (!signal) return { action: "discard", project: null };
	if (signal.vault && signal.vault !== myVault) return { action: "ignore", project: null };
	const project = projectFromSessionName(signal.tmuxSession, projects);
	if (project) return { action: "consume", project };
	return signal.vault === myVault
		? { action: "discard", project: null }
		: { action: "ignore", project: null };
}

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

interface ClaudeHookEntry {
	type: string;
	command: string;
	timeout?: number;
}

interface ClaudeHookMatcher {
	matcher: string;
	hooks: ClaudeHookEntry[];
}

// Single-quote a path for /bin/sh -c. Required because the registered command
// is run via shell, and unquoted paths with spaces (e.g. iCloud's "Mobile
// Documents/") get word-split into "command not found".
export function shellQuoteSingle(path: string): string {
	return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Register one hook command in an engine's settings.json, repairing a
 * stale/unquoted entry in place. Engine-agnostic: the caller supplies the
 * event name and script, which come from the engine definition.
 *
 * `scriptPath` is null when the plugin could not make its own copy of that
 * script runnable. An engine's settings file is shared by every vault, so
 * registering a path that does not exist would silently replace a working
 * entry another vault wrote and break completion detection for both. In that
 * case, leave the file exactly as it is.
 */
export function ensureEngineHookConfig(
	settingsJson: string,
	hookEvent: string,
	scriptBaseName: string,
	scriptPath: string | null,
): { updated: boolean; content: string } {
	if (!scriptPath) return { updated: false, content: settingsJson };

	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(settingsJson) as Record<string, unknown>;
	} catch {
		return { updated: false, content: settingsJson };
	}

	const expectedCommand = shellQuoteSingle(scriptPath);
	const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
	const matchers = (hooks[hookEvent] ?? []) as ClaudeHookMatcher[];

	const existing = matchers
		.flatMap((m) => m.hooks ?? [])
		.find((h) => h.command?.includes(scriptBaseName));

	if (existing) {
		if (existing.command === expectedCommand) {
			return { updated: false, content: settingsJson };
		}
		// Wrong command (unquoted path, stale path, etc.) — repair in place.
		existing.command = expectedCommand;
		hooks[hookEvent] = matchers;
		settings.hooks = hooks;
		return { updated: true, content: JSON.stringify(settings, null, 2) };
	}

	matchers.push({
		matcher: "*",
		hooks: [{
			type: "command",
			command: expectedCommand,
			timeout: 10,
		}],
	});

	hooks[hookEvent] = matchers;
	settings.hooks = hooks;

	return {
		updated: true,
		content: JSON.stringify(settings, null, 2),
	};
}

export function ensureStopHookConfig(
	settingsJson: string,
	scriptPath: string | null,
): { updated: boolean; content: string } {
	return ensureEngineHookConfig(settingsJson, "Stop", "co-stop-hook.sh", scriptPath);
}

/**
 * Notification hook: permission requests are a structured, reliable
 * "Claude is asking" signal (vs. guessing from transcript regexes).
 */
export function ensureNotificationHookConfig(
	settingsJson: string,
	scriptPath: string | null,
): { updated: boolean; content: string } {
	return ensureEngineHookConfig(settingsJson, "Notification", "co-notification-hook.sh", scriptPath);
}
