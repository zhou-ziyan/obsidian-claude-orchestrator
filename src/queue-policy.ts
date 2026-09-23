/**
 * Queue engine decision rules: what a stop signal or note edit should
 * trigger (send / notify / nothing) and how sent tasks are prepared.
 */
import { stripTimestamp } from "./session-note.ts";
import type { HistoryItem, QueueMode, SessionStatus } from "./session-note.ts";
import type { StopReason } from "./stop-signal.ts";
import { escapeLeadingBang } from "./tmux.ts";

export type AutoSendAction = "send" | "notify" | "none";

export function autoSendAction(
	mode: QueueMode,
	stopReason: StopReason | null,
	queueLength: number,
): AutoSendAction {
	if (mode === "manual") return "none";
	// Only an explicit completion (or a later note change while a completion
	// remains stably idle) may advance the queue.
	if (stopReason !== null && stopReason !== "done") return "none";
	if (queueLength === 0) return "none";
	if (mode === "auto") return "send";
	if (mode === "listen") return "notify";
	return "none";
}

export function deriveStatusFromStop(
	stopReason: StopReason | null,
): { claudeIdle: boolean; status: SessionStatus } {
	if (stopReason === "started") return { claudeIdle: false, status: "running" };
	if (stopReason === "asking") return { claudeIdle: false, status: "waiting_for_user" };
	// An aborted turn still leaves the agent idle — Codex fires Interrupt
	// *instead of* Stop, never both, so treating error as "still running"
	// would strand the session with no completion signal ever coming. The
	// queue is held back by autoSendAction on this signal rather than by
	// pretending a turn is in flight; a later note edit may resume, which is
	// what the user adding new work after an interrupt actually wants.
	if (stopReason === "error") return { claudeIdle: true, status: "error" };
	return { claudeIdle: true, status: "idle" };
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

export function notifyQueueMessage(prefix: string, queueLength: number): string {
	return `${prefix} — ${queueLength} item(s) in queue`;
}

export function prepareQueueTaskText(rawTask: string): string {
	const text = stripTimestamp(rawTask);
	// Whitespace alone is not a reliable escape for CLI shell shortcuts.
	// Keep Obsidian embeds intact, but start image/attachment prompts with prose.
	if (/^\s*!\[\[/.test(text)) return "请查看以下附件：\n" + text;
	return escapeLeadingBang(text);
}
