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
	/** Vault name the session belongs to (from tmux @co_vault); null on
	 * signals written by older hook scripts. */
	vault: string | null;
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
	};
}

/** Signals that no vault claims are cleaned up after this TTL. */

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

// Single-quote a path for /bin/sh -c. Required because the registered command
// is run via shell, and unquoted paths with spaces (e.g. iCloud's "Mobile
// Documents/") get word-split into "command not found".
export function shellQuoteSingle(path: string): string {
	return `'${path.replace(/'/g, "'\\''")}'`;
}

function ensureClaudeHookConfig(
	settingsJson: string,
	hookEvent: string,
	scriptBaseName: string,
	scriptPath: string,
): { updated: boolean; content: string } {
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
	scriptPath: string,
): { updated: boolean; content: string } {
	return ensureClaudeHookConfig(settingsJson, "Stop", "co-stop-hook.sh", scriptPath);
}

/**
 * Notification hook: permission requests are a structured, reliable
 * "Claude is asking" signal (vs. guessing from transcript regexes).
 */

/**
 * Notification hook: permission requests are a structured, reliable
 * "Claude is asking" signal (vs. guessing from transcript regexes).
 */
export function ensureNotificationHookConfig(
	settingsJson: string,
	scriptPath: string,
): { updated: boolean; content: string } {
	return ensureClaudeHookConfig(settingsJson, "Notification", "co-notification-hook.sh", scriptPath);
}
