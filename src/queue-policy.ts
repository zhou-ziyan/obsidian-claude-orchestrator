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
	if (stopReason === "asking") return "none";
	if (queueLength === 0) return "none";
	if (mode === "auto") return "send";
	if (mode === "listen") return "notify";
	return "none";
}

/**
 * Reverse-map a vault file path to the tmux session it is the note for.
 * Returns null for archives, non-markdown files, nested paths, and paths
 * outside every registered project's sessions directory.
 */

/**
 * After editing a queue item, determine whether to auto-send.
 * Returns true when the queue has exactly 1 item — the one just edited —
 * so save-and-send can happen in one Enter press.
 */
export function shouldAutoSendAfterEdit(queueLength: number): boolean {
	return queueLength === 1;
}

export function deriveStatusFromStop(
	stopReason: StopReason | null,
): { claudeIdle: boolean; status: SessionStatus } {
	const claudeIdle = stopReason !== "asking";
	const status: SessionStatus = stopReason === "asking" ? "waiting_for_user" : "idle";
	return { claudeIdle, status };
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
	return escapeLeadingBang(stripTimestamp(rawTask));
}
