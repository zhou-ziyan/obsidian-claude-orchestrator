import {
	autoSendAction,
	buildQuickReplyTmuxArgs,
	cancelCopyModeArgs,
	deriveStatusFromStop,
	escapeLeadingBang,
	markLastHistoryDone,
	notifyQueueMessage,
	prepareQueueTaskText,
} from "./utils.ts";
import type { SessionNote, StopReason } from "./utils.ts";

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
}

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
 * status is only used to seed a session the engine has never seen.
 */
export class QueueEngine {
	private store: NoteStore;
	private exec: (args: string[]) => Promise<string>;
	private notifier: EngineNotifier;
	private getCountdownSeconds: () => number;
	private playSoundOnAsking: () => boolean;
	private onUpdate: (sessionName: string) => void;
	private sendKeyDelayMs: number;

	private idle = new Map<string, boolean>();
	private countdowns = new Map<string, Countdown>();
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
	}

	async onStopSignal(sessionName: string, reason: StopReason): Promise<void> {
		const note = await this.store.read(sessionName);
		if (!note) return;

		const derived = deriveStatusFromStop(reason);
		this.idle.set(sessionName, derived.claudeIdle);
		note.status = derived.status;
		markLastHistoryDone(note.history, reason);
		await this.writeNote(sessionName, note);

		const action = autoSendAction(note.queueMode, reason, note.queue.length);
		if (action === "send") {
			this.startCountdown(sessionName);
		} else if (action === "notify") {
			this.notifier.notify(notifyQueueMessage("Claude finished", note.queue.length));
		}

		if (reason === "asking" && this.playSoundOnAsking()) {
			this.notifier.soundOnAsking();
		}
		this.onUpdate(sessionName);
	}

	/** Vault-modify entry: a session note changed outside the engine (view
	 * edit, external agent, hand edit). May start an idle auto-send. */
	async onNoteChanged(sessionName: string): Promise<void> {
		if (this.countdowns.has(sessionName)) return;
		const note = await this.store.read(sessionName);
		if (!note) return;

		if (!this.idle.has(sessionName)) {
			// First sighting — seed from the note. Later flips of the status
			// field alone are ignored: only stop signals mark a session idle.
			this.idle.set(sessionName, note.status === "idle");
		}
		if (!this.idle.get(sessionName)) return;

		const action = autoSendAction(note.queueMode, null, note.queue.length);
		if (action === "send") {
			this.startCountdown(sessionName);
		} else if (action === "notify") {
			this.notifier.notify(notifyQueueMessage("Claude idle", note.queue.length));
		}
	}

	async sendNext(sessionName: string): Promise<void> {
		this.cancelCountdown(sessionName);
		const note = await this.store.read(sessionName);
		if (!note || note.queue.length === 0) return;

		this.idle.set(sessionName, false);
		note.status = "running";
		const task = note.queue.shift()!;
		note.history.push({ text: task, completed: false });
		await this.writeNote(sessionName, note);

		await this.sendLiteral(sessionName, prepareQueueTaskText(task), true);
		this.onUpdate(sessionName);
	}

	async sendQuickReply(sessionName: string, key: string): Promise<void> {
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
			this.track(this.sendNext(sessionName));
			return;
		}
		const timer = setInterval(() => {
			const cd = this.countdowns.get(sessionName);
			if (!cd) return;
			cd.remaining--;
			if (cd.remaining <= 0) {
				this.cancelCountdown(sessionName);
				this.track(this.sendNext(sessionName));
			} else {
				this.onUpdate(sessionName);
			}
		}, 1000);
		this.countdowns.set(sessionName, { remaining: total, timer });
		this.onUpdate(sessionName);
	}

	private async sendLiteral(sessionName: string, text: string, withEnter: boolean): Promise<void> {
		await this.exec(cancelCopyModeArgs(sessionName)).catch(() => {});
		await this.exec(["send-keys", "-l", "-t", sessionName, "--", text]);
		if (withEnter) {
			await this.delay();
			await this.exec(["send-keys", "-t", sessionName, "Enter"]);
		}
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
		return new Promise((r) => setTimeout(r, this.sendKeyDelayMs));
	}

	private track(p: Promise<void>): void {
		this.pending = this.pending.then(() => p.catch(() => {}));
	}
}
