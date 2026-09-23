import {
	autoSendAction,
	deriveStatusFromStop,
	markLastHistoryDone,
	notifyQueueMessage,
	prepareQueueTaskText,
} from "./queue-policy.ts";
import { buildQuickReplyTmuxArgs, cancelCopyModeArgs, escapeLeadingBang } from "./tmux.ts";
import { effectiveQueueMode, resolveEngineRef } from "./engines.ts";
import type { QueueMode, SessionNote } from "./session-note.ts";
import type { StopReason } from "./stop-signal.ts";

/**
 * Note persistence abstraction. The production implementation resolves the
 * session's project and reads/writes the vault file; tests use an in-memory
 * map. Keyed by tmux session name.
 */
export interface NoteStore {
	read(sessionName: string): Promise<SessionNote | null>;
	write(sessionName: string, note: SessionNote): Promise<void>;
}

export interface EngineNotifier {
	notify(message: string): void;
	soundOnAsking(): void;
}

export interface QueueEngineOptions {
	store: NoteStore;
	/** execTmux, injectable for tests. */
	exec: (args: string[]) => Promise<string>;
	notifier: EngineNotifier;
	getCountdownSeconds: () => number;
	playSoundOnAsking: () => boolean;
	/** UI refresh hook — fired whenever a session's state changes. */
	onUpdate?: (sessionName: string) => void;
	/** Pause between literal text and Enter, matching interactive typing. */
	sendKeyDelayMs?: number;
	/** A completion must remain uncontested for this long before any send is
	 * eligible. This is separate from the visible Auto countdown. */
	idleStabilityMs?: number;
}

/** How far a send got, so a failure can be recovered without re-running
 * work the agent has already received. */
type SendOutcome = "sent" | "text-failed" | "enter-failed";

interface Countdown {
	remaining: number;
	timer: ReturnType<typeof setInterval>;
}

/**
 * Headless queue engine: the single owner of the stop-signal →
 * status/history → auto-send pipeline. It only needs a note store and tmux —
 * terminal panels and the session manager are pure UI on top, so closing a
 * tab never stalls a session's queue.
 *
 * Idle tracking: the engine trusts its own observations (stop signals, its
 * own sends) over the note's status field, which anyone can edit. The note
 * status is never enough to arm an automatic send by itself.
 */
export class QueueEngine {
	private store: NoteStore;
	private exec: (args: string[]) => Promise<string>;
	private notifier: EngineNotifier;
	private getCountdownSeconds: () => number;
	private playSoundOnAsking: () => boolean;
	private onUpdate: (sessionName: string) => void;
	private sendKeyDelayMs: number;
	private idleStabilityMs: number;

	private idle = new Map<string, boolean>();
	private stableIdle = new Set<string>();
	private revisions = new Map<string, number>();
	private providers = new Map<string, string>();
	private countdowns = new Map<string, Countdown>();
	private stabilityTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private lifecycleEvents = new Set<string>();
	private writing = new Set<string>();
	private pending: Promise<void> = Promise.resolve();

	constructor(opts: QueueEngineOptions) {
		this.store = opts.store;
		this.exec = opts.exec;
		this.notifier = opts.notifier;
		this.getCountdownSeconds = opts.getCountdownSeconds;
		this.playSoundOnAsking = opts.playSoundOnAsking;
		this.onUpdate = opts.onUpdate ?? (() => {});
		this.sendKeyDelayMs = opts.sendKeyDelayMs ?? 150;
		this.idleStabilityMs = opts.idleStabilityMs ?? 750;
	}

	/** True while the engine itself is writing this session's note — lets the
	 * vault-modify wiring skip self-inflicted onNoteChanged calls. */
	isSelfWrite(sessionName: string): boolean {
		return this.writing.has(sessionName);
	}

	isIdle(sessionName: string): boolean {
		return this.idle.get(sessionName) ?? false;
	}

	getCountdownRemaining(sessionName: string): number {
		return this.countdowns.get(sessionName)?.remaining ?? 0;
	}

	/** Await in-flight sends (tests, plugin unload). */
	async flush(): Promise<void> {
		await this.pending;
	}

	dispose(): void {
		for (const name of [...this.countdowns.keys()]) this.cancelCountdown(name);
		for (const timer of this.stabilityTimers.values()) clearTimeout(timer);
		this.stabilityTimers.clear();
	}

	async onStopSignal(sessionName: string, reason: StopReason): Promise<void> {
		const note = await this.store.read(sessionName);
		const provider = note ? resolveEngineRef(note.engine).id : null;
		if (!provider) return;
		await this.onLifecycleSignal(sessionName, reason, provider);
	}

	/** Provider-scoped lifecycle entry point used by the hook watcher. A
	 * turn-start disarms every send path; only a matching provider's explicit
	 * done signal may begin the stable-idle window. */
	async onLifecycleSignal(
		sessionName: string,
		reason: StopReason,
		provider: string,
		eventId?: string,
	): Promise<void> {
		if (eventId && this.lifecycleEvents.has(eventId)) return;
		const knownProvider = this.providers.get(sessionName);
		if (knownProvider !== undefined && knownProvider !== provider) return;
		// Busy / waiting / interrupted signals fail closed immediately, before
		// the note read. This closes the race where a gated send is itself
		// awaiting storage while a new turn begins.
		if (reason !== "done" && knownProvider === provider) {
			this.cancelCountdown(sessionName);
			this.cancelStability(sessionName);
			this.stableIdle.delete(sessionName);
			this.idle.set(sessionName, reason === "error");
			this.bumpRevision(sessionName);
		}
		const note = await this.store.read(sessionName);
		if (!note) return;
		const configuredProvider = resolveEngineRef(note.engine).id;
		if (configuredProvider !== provider) return;
		this.providers.set(sessionName, provider);
		if (eventId) {
			this.lifecycleEvents.add(eventId);
			if (this.lifecycleEvents.size > 500) {
				const oldest = this.lifecycleEvents.values().next().value as string | undefined;
				if (oldest) this.lifecycleEvents.delete(oldest);
			}
		}

		this.cancelCountdown(sessionName);
		this.cancelStability(sessionName);
		this.stableIdle.delete(sessionName);
		this.bumpRevision(sessionName);

		if (reason === "started") {
			this.cancelCountdown(sessionName);
			this.idle.set(sessionName, false);
			note.status = "running";
			await this.writeNote(sessionName, note);
			this.onUpdate(sessionName);
			return;
		}

		const derived = deriveStatusFromStop(reason);
		this.idle.set(sessionName, derived.claudeIdle);
		note.status = derived.status;
		markLastHistoryDone(note.history, reason);
		await this.writeNote(sessionName, note);

		if (reason === "asking" && this.playSoundOnAsking()) {
			this.notifier.soundOnAsking();
		}
		if (reason === "done") this.beginStableIdle(sessionName, note);
		this.onUpdate(sessionName);
	}

	/** Vault-modify entry: a session note changed outside the engine (view
	 * edit, external agent, hand edit). May start an idle auto-send. */
	async onNoteChanged(sessionName: string): Promise<void> {
		if (this.countdowns.has(sessionName)) return;
		const note = await this.store.read(sessionName);
		if (!note) return;

		// A persisted `status: idle` is not proof that the live agent finished:
		// the note may be stale while Claude/Codex is still running. Only a
		// provider-matched completion signal can arm this process instance.
		if (!this.idle.get(sessionName) || !this.stableIdle.has(sessionName)) return;

		const action = autoSendAction(this.queueModeFor(note), null, note.queue.length);
		if (action === "send") {
			this.startCountdown(sessionName);
		} else if (action === "notify") {
			this.notifier.notify(notifyQueueMessage("Claude idle", note.queue.length));
		}
	}

	/** The note's queue mode, clamped to what its engine can honor. An
	 * engine with no completion signal never drives the queue on its own —
	 * explicit sendNext still works. */
	private queueModeFor(note: SessionNote): QueueMode {
		return effectiveQueueMode(resolveEngineRef(note.engine), note.queueMode);
	}

	async sendNext(sessionName: string): Promise<void> {
		await this.attemptSendNext(sessionName, true);
	}

	/** Persist an inline queue edit without entering the send pipeline. Both
	 * the confirmation button and Enter use this exact method. */
	async saveQueueEdit(sessionName: string, index: number, text: string): Promise<void> {
		this.cancelCountdown(sessionName);
		this.cancelStability(sessionName);
		const note = await this.store.read(sessionName);
		if (!note || index < 0 || index >= note.queue.length || text.trim() === "") return;
		note.queue[index] = text;
		await this.writeNote(sessionName, note);
		this.onUpdate(sessionName);
	}

	private async attemptSendNext(sessionName: string, notifyWhenBlocked: boolean): Promise<void> {
		const revision = this.revisions.get(sessionName) ?? 0;
		let note = await this.store.read(sessionName);
		if (!note || note.queue.length === 0) return;

		// A deliberate Send Next must remain usable after plugin startup, when
		// no lifecycle event has occurred in this process yet. In that one case,
		// require the persisted idle state to remain unchanged for the same
		// stability window, then read it again. Auto-send never uses this path.
		if (!this.sendGateOpen(sessionName, revision)
			&& notifyWhenBlocked
			&& !this.idle.has(sessionName)
			&& note.status === "idle"
			&& resolveEngineRef(note.engine).id !== null) {
			await this.wait(this.idleStabilityMs);
			const confirmed = await this.store.read(sessionName);
			if (confirmed?.status === "idle"
				&& confirmed.queue.length > 0
				&& (this.revisions.get(sessionName) ?? 0) === revision) {
				this.idle.set(sessionName, true);
				this.stableIdle.add(sessionName);
				note = confirmed;
			}
		}
		// Second validation happens after the async read and immediately before
		// claiming the item. A turn-start or non-completion signal increments the
		// revision synchronously, so it wins this race without consuming Queue.
		if (!this.sendGateOpen(sessionName, revision)) {
			if (notifyWhenBlocked) this.notifier.notify("Send held — session became busy");
			return;
		}

		const previousStatus = note.status;
		note.status = "running";
		const task = note.queue.shift()!;
		note.history.push({ text: task, completed: false });
		await this.writeNote(sessionName, note);
		if (!this.sendGateOpen(sessionName, revision)) {
			await this.restoreUnsentTask(sessionName, task, previousStatus);
			if (notifyWhenBlocked) this.notifier.notify("Send held — session became busy");
			return;
		}

		this.cancelCountdown(sessionName);
		this.cancelStability(sessionName);
		this.stableIdle.delete(sessionName);
		this.idle.set(sessionName, false);
		this.bumpRevision(sessionName);

		const outcome = await this.sendLiteral(sessionName, prepareQueueTaskText(task), true);
		if (outcome === "text-failed") {
			// Nothing reached the agent, so the task is still owed. Put it back
			// at the head of the queue and drop the history entry — otherwise
			// the item is silently lost with no way to retry it.
			const current = await this.store.read(sessionName);
			if (current) {
				const last = current.history[current.history.length - 1];
				if (last && !last.completed && last.text === task) current.history.pop();
				current.queue.unshift(task);
				current.status = previousStatus === "running" ? "idle" : previousStatus;
				await this.writeNote(sessionName, current);
			}
			this.idle.set(sessionName, previousStatus !== "running");
			if (previousStatus !== "running") this.stableIdle.add(sessionName);
			this.notifier.notify("Send failed — task returned to the queue");
		} else if (outcome === "enter-failed") {
			// The prompt text is already sitting in the agent's input box.
			// Re-queueing it would type it twice, so keep it in history and
			// tell the user the one keystroke that is missing.
			this.notifier.notify("Send incomplete — press Enter in the terminal to submit");
		}
		this.onUpdate(sessionName);
	}

	async sendQuickReply(sessionName: string, key: string): Promise<void> {
		this.cancelCountdown(sessionName);
		this.cancelStability(sessionName);
		this.stableIdle.delete(sessionName);
		this.bumpRevision(sessionName);
		const note = await this.store.read(sessionName);
		if (note) {
			note.status = "running";
			await this.writeNote(sessionName, note);
		}
		this.idle.set(sessionName, false);

		const { textArgs, enterArgs } = buildQuickReplyTmuxArgs(sessionName, escapeLeadingBang(key));
		await this.exec(cancelCopyModeArgs(sessionName)).catch(() => {});
		await this.exec(textArgs);
		if (enterArgs.length > 0) {
			await this.delay();
			await this.exec(enterArgs);
		}
		this.onUpdate(sessionName);
	}

	cancelCountdown(sessionName: string): void {
		const cd = this.countdowns.get(sessionName);
		if (!cd) return;
		clearInterval(cd.timer);
		this.countdowns.delete(sessionName);
		this.onUpdate(sessionName);
	}

	private startCountdown(sessionName: string): void {
		this.cancelCountdown(sessionName);
		const total = this.getCountdownSeconds();
		if (total <= 0) {
			this.track(this.attemptSendNext(sessionName, false));
			return;
		}
		const timer = setInterval(() => {
			const cd = this.countdowns.get(sessionName);
			if (!cd) return;
			cd.remaining--;
			if (cd.remaining <= 0) {
				this.cancelCountdown(sessionName);
				this.track(this.attemptSendNext(sessionName, false));
			} else {
				this.onUpdate(sessionName);
			}
		}, 1000);
		this.countdowns.set(sessionName, { remaining: total, timer });
		this.onUpdate(sessionName);
	}

	private beginStableIdle(sessionName: string, note: SessionNote): void {
		const revision = this.revisions.get(sessionName) ?? 0;
		const settle = () => {
			this.stabilityTimers.delete(sessionName);
			if (!this.idle.get(sessionName) || (this.revisions.get(sessionName) ?? 0) !== revision) return;
			this.stableIdle.add(sessionName);
			const action = autoSendAction(this.queueModeFor(note), "done", note.queue.length);
			if (action === "send") {
				this.startCountdown(sessionName);
			} else if (action === "notify") {
				this.notifier.notify(notifyQueueMessage("Agent finished", note.queue.length));
			}
			this.onUpdate(sessionName);
		};
		if (this.idleStabilityMs <= 0) {
			settle();
			return;
		}
		this.stabilityTimers.set(sessionName, setTimeout(settle, this.idleStabilityMs));
	}

	private cancelStability(sessionName: string): void {
		const timer = this.stabilityTimers.get(sessionName);
		if (timer) clearTimeout(timer);
		this.stabilityTimers.delete(sessionName);
	}

	private bumpRevision(sessionName: string): number {
		const next = (this.revisions.get(sessionName) ?? 0) + 1;
		this.revisions.set(sessionName, next);
		return next;
	}

	private sendGateOpen(sessionName: string, revision: number): boolean {
		return this.idle.get(sessionName) === true
			&& this.stableIdle.has(sessionName)
			&& (this.revisions.get(sessionName) ?? 0) === revision;
	}

	private async restoreUnsentTask(sessionName: string, task: string, previousStatus: SessionNote["status"]): Promise<void> {
		const current = await this.store.read(sessionName);
		if (!current) return;
		const last = current.history[current.history.length - 1];
		if (last && !last.completed && last.text === task) {
			current.history.pop();
			current.queue.unshift(task);
		}
		if (this.idle.get(sessionName)) current.status = previousStatus;
		await this.writeNote(sessionName, current);
	}

	private async sendLiteral(sessionName: string, text: string, withEnter: boolean): Promise<SendOutcome> {
		await this.exec(cancelCopyModeArgs(sessionName)).catch(() => {});
		try {
			await this.exec(["send-keys", "-l", "-t", sessionName, "--", text]);
		} catch {
			return "text-failed";
		}
		if (withEnter) {
			await this.delay();
			try {
				await this.exec(["send-keys", "-t", sessionName, "Enter"]);
			} catch {
				return "enter-failed";
			}
		}
		return "sent";
	}

	private async writeNote(sessionName: string, note: SessionNote): Promise<void> {
		this.writing.add(sessionName);
		try {
			await this.store.write(sessionName, note);
		} finally {
			// Let the vault-modify event for our own write drain before
			// clearing the marker.
			setTimeout(() => this.writing.delete(sessionName), 200);
		}
	}

	private delay(): Promise<void> {
		if (this.sendKeyDelayMs <= 0) return Promise.resolve();
		return this.wait(this.sendKeyDelayMs);
	}

	private wait(ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		return new Promise((r) => setTimeout(r, ms));
	}

	private track(p: Promise<void>): void {
		this.pending = this.pending.then(() => p.catch(() => {}));
	}
}
