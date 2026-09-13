import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueueEngine } from "../src/queue-engine.ts";
import type { SessionNote } from "../src/utils.ts";
import { parseSessionNote } from "../src/utils.ts";

// @types/node v16 predates node:test mock timers — type the accessor locally.
interface MockTimers {
	enable(opts: { apis: string[] }): void;
	tick(ms: number): void;
}
function timers(t: unknown): MockTimers {
	return (t as { mock: { timers: MockTimers } }).mock.timers;
}

function makeNote(over: Partial<SessionNote> = {}): SessionNote {
	return {
		session: "P-1",
		status: "running",
		queueMode: "manual",
		displayName: "",
		summary: "",
		engine: "", model: "",
		notes: "",
		history: [],
		queue: [],
		...over,
	};
}

interface Harness {
	engine: QueueEngine;
	notes: Map<string, SessionNote>;
	writes: { session: string; note: SessionNote }[];
	execs: string[][];
	notifications: string[];
	askingSounds: number;
	updates: string[];
}

function makeHarness(note: SessionNote, opts: { countdownSeconds?: number; playSoundOnAsking?: boolean } = {}): Harness {
	const notes = new Map<string, SessionNote>([[note.session, note]]);
	const writes: { session: string; note: SessionNote }[] = [];
	const execs: string[][] = [];
	const notifications: string[] = [];
	const updates: string[] = [];
	const h: Harness = { engine: null as unknown as QueueEngine, notes, writes, execs, notifications, askingSounds: 0, updates };
	h.engine = new QueueEngine({
		store: {
			read: (s) => Promise.resolve(notes.has(s) ? structuredClone(notes.get(s)!) : null),
			write: (s, n) => {
				notes.set(s, structuredClone(n));
				writes.push({ session: s, note: structuredClone(n) });
				return Promise.resolve();
			},
		},
		exec: (args) => { execs.push(args); return Promise.resolve(""); },
		notifier: {
			notify: (m) => { notifications.push(m); },
			soundOnAsking: () => { h.askingSounds++; },
		},
		getCountdownSeconds: () => opts.countdownSeconds ?? 3,
		playSoundOnAsking: () => opts.playSoundOnAsking ?? false,
		onUpdate: (s) => { updates.push(s); },
		sendKeyDelayMs: 0,
	});
	return h;
}

describe("QueueEngine stop signal", () => {
	it("marks history done and sets idle status on done, with no panel involved", async () => {
		const h = makeHarness(makeNote({
			history: [{ text: "task A", completed: false }],
		}));
		await h.engine.onStopSignal("P-1", "done");
		const saved = h.notes.get("P-1")!;
		assert.equal(saved.status, "idle");
		assert.equal(saved.history[0]!.completed, true);
		assert.equal(h.engine.isIdle("P-1"), true);
	});

	it("auto mode: starts countdown on done and sends the next item when it elapses", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ queueMode: "auto", queue: ["[2026-07-06 10:00] next task"] }), { countdownSeconds: 3 });
		await h.engine.onStopSignal("P-1", "done");
		assert.equal(h.engine.getCountdownRemaining("P-1"), 3);
		assert.equal(h.execs.length, 0, "nothing sent during countdown");
		timers(t).tick(3000);
		await h.engine.flush();
		const saved = h.notes.get("P-1")!;
		assert.equal(saved.queue.length, 0);
		assert.equal(saved.history.at(-1)!.text, "[2026-07-06 10:00] next task");
		assert.equal(saved.status, "running");
		const sendKeys = h.execs.find((a) => a.includes("-l"));
		assert.ok(sendKeys, "literal send-keys issued");
		assert.ok(sendKeys.join(" ").includes("next task"));
		assert.equal(h.engine.isIdle("P-1"), false);
	});

	it("listen mode: notifies without sending", async () => {
		const h = makeHarness(makeNote({ queueMode: "listen", queue: ["x"] }));
		await h.engine.onStopSignal("P-1", "done");
		assert.equal(h.notifications.length, 1);
		assert.equal(h.execs.length, 0);
		assert.equal(h.engine.getCountdownRemaining("P-1"), 0);
	});

	it("manual mode: only updates the note", async () => {
		const h = makeHarness(makeNote({ queueMode: "manual", queue: ["x"] }));
		await h.engine.onStopSignal("P-1", "done");
		assert.equal(h.notifications.length, 0);
		assert.equal(h.execs.length, 0);
		assert.equal(h.notes.get("P-1")!.status, "idle");
	});

	it("asking: sets waiting_for_user, never auto-sends, chimes when enabled", async () => {
		const h = makeHarness(makeNote({ queueMode: "auto", queue: ["x"] }), { playSoundOnAsking: true });
		await h.engine.onStopSignal("P-1", "asking");
		assert.equal(h.notes.get("P-1")!.status, "waiting_for_user");
		assert.equal(h.engine.getCountdownRemaining("P-1"), 0);
		assert.equal(h.execs.length, 0);
		assert.equal(h.askingSounds, 1);
		assert.equal(h.engine.isIdle("P-1"), false);
	});

	it("ignores sessions without a note", async () => {
		const h = makeHarness(makeNote());
		await h.engine.onStopSignal("unknown-9", "done");
		assert.equal(h.writes.length, 0);
	});
});

describe("QueueEngine sendNext", () => {
	it("moves the item to history, saves before sending, and sends in order", async () => {
		const h = makeHarness(makeNote({ queue: ["[2026-07-06 10:00] do the thing", "later"] }));
		await h.engine.sendNext("P-1");
		const saved = h.notes.get("P-1")!;
		assert.equal(saved.status, "running");
		assert.deepStrictEqual(saved.queue, ["later"]);
		assert.equal(saved.history.at(-1)!.completed, false);
		assert.equal(h.writes.length, 1, "note persisted exactly once");
		// exec order: cancel copy-mode → literal text → Enter
		assert.deepStrictEqual(h.execs[0], ["send-keys", "-t", "P-1", "-X", "cancel"]);
		assert.ok(h.execs[1]!.includes("-l"));
		assert.equal(h.execs[2]!.at(-1), "Enter");
	});

	it("no-ops on an empty queue", async () => {
		const h = makeHarness(makeNote({ queue: [] }));
		await h.engine.sendNext("P-1");
		assert.equal(h.writes.length, 0);
		assert.equal(h.execs.length, 0);
	});

	it("cancelCountdown aborts a pending auto-send", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ queueMode: "auto", queue: ["x"] }), { countdownSeconds: 5 });
		await h.engine.onStopSignal("P-1", "done");
		assert.equal(h.engine.getCountdownRemaining("P-1"), 5);
		h.engine.cancelCountdown("P-1");
		timers(t).tick(10_000);
		await h.engine.flush();
		assert.equal(h.notes.get("P-1")!.queue.length, 1, "item still queued");
	});
});

describe("QueueEngine note changes (external edits / view edits)", () => {
	it("starts countdown when idle in auto mode and a task appears", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ status: "idle", queueMode: "auto", queue: ["new task"] }), { countdownSeconds: 2 });
		await h.engine.onNoteChanged("P-1"); // idle seeded from note.status
		assert.equal(h.engine.getCountdownRemaining("P-1"), 2);
		timers(t).tick(2000);
		await h.engine.flush();
		assert.equal(h.notes.get("P-1")!.queue.length, 0);
	});

	it("notifies (not sends) in listen mode when idle and a task appears", async () => {
		const h = makeHarness(makeNote({ status: "idle", queueMode: "listen", queue: ["t"] }));
		await h.engine.onNoteChanged("P-1");
		assert.equal(h.notifications.length, 1);
		assert.equal(h.execs.length, 0);
	});

	it("does not trust an externally written idle status when it knows Claude is busy", async () => {
		const h = makeHarness(makeNote({ queueMode: "auto", queue: [] }));
		await h.engine.onStopSignal("P-1", "asking"); // engine now knows: not idle
		const external = h.notes.get("P-1")!;
		external.status = "idle";
		external.queue = ["sneaky task"];
		h.notes.set("P-1", external);
		await h.engine.onNoteChanged("P-1");
		assert.equal(h.engine.getCountdownRemaining("P-1"), 0);
		assert.equal(h.execs.length, 0);
	});

	it("does nothing while a countdown is already pending", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ queueMode: "auto", queue: ["a", "b"] }), { countdownSeconds: 5 });
		await h.engine.onStopSignal("P-1", "done");
		await h.engine.onNoteChanged("P-1");
		assert.equal(h.engine.getCountdownRemaining("P-1"), 5, "no restart/stack");
	});
});

describe("QueueEngine quick reply", () => {
	it("sends the key, cancels copy-mode first, and marks running", async () => {
		const h = makeHarness(makeNote({ status: "waiting_for_user" }));
		await h.engine.sendQuickReply("P-1", "yes");
		assert.equal(h.notes.get("P-1")!.status, "running");
		assert.deepStrictEqual(h.execs[0], ["send-keys", "-t", "P-1", "-X", "cancel"]);
		assert.ok(h.execs[1]!.join(" ").includes("yes"));
		assert.equal(h.engine.isIdle("P-1"), false);
	});

	it("escapes a leading bang", async () => {
		const h = makeHarness(makeNote());
		await h.engine.sendQuickReply("P-1", "!continue");
		const literal = h.execs.find((a) => a.includes("-l"))!;
		assert.equal(literal.at(-1), " !continue");
	});
});

describe("QueueEngine round-trip with real note markdown", () => {
	it("drives a parseSessionNote-produced note end to end", async () => {
		const md = [
			"---", "session: P-1", "status: idle", "queueMode: auto", "---", "",
			"## Notes", "", "## History", "- [x] [2026-07-06 09:00] earlier", "",
			"## Queue", "- [2026-07-06 10:00] pending task", "",
		].join("\n");
		const h = makeHarness(parseSessionNote(md, "P-1"), { countdownSeconds: 0 });
		await h.engine.onStopSignal("P-1", "done");
		await h.engine.flush();
		const saved = h.notes.get("P-1")!;
		assert.equal(saved.queue.length, 0, "countdown of 0 sends immediately");
		assert.equal(saved.history.length, 2);
	});
});

// ---------------------------------------------------------------------------
// Engine capability gating — an engine with no reliable completion signal
// must never drive the queue on its own.
// ---------------------------------------------------------------------------

describe("QueueEngine engine capability", () => {
	it("auto mode still auto-sends for Claude", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ engine: "claude", queueMode: "auto", queue: ["next task"] }), { countdownSeconds: 1 });
		await h.engine.onStopSignal("P-1", "done");
		timers(t).tick(1000);
		await h.engine.flush();
		assert.equal(h.notes.get("P-1")!.queue.length, 0);
	});

	it("auto mode still auto-sends for a legacy note with no engine field", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ queueMode: "auto", queue: ["next task"] }), { countdownSeconds: 1 });
		await h.engine.onStopSignal("P-1", "done");
		timers(t).tick(1000);
		await h.engine.flush();
		assert.equal(h.notes.get("P-1")!.queue.length, 0);
	});

	it("never auto-sends when the note names an engine we cannot drive", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ engine: "gpt-5-turbo", queueMode: "auto", queue: ["next task"] }), { countdownSeconds: 1 });
		await h.engine.onStopSignal("P-1", "done");
		assert.equal(h.engine.getCountdownRemaining("P-1"), 0, "no countdown started");
		timers(t).tick(5000);
		await h.engine.flush();
		assert.equal(h.notes.get("P-1")!.queue.length, 1, "queue item still waiting");
		assert.equal(h.execs.length, 0, "nothing typed into tmux");
	});

	it("does not even notify in listen mode for an undrivable engine", async () => {
		const h = makeHarness(makeNote({ engine: "gpt-5-turbo", queueMode: "listen", queue: ["x"] }));
		await h.engine.onStopSignal("P-1", "done");
		assert.equal(h.notifications.length, 0);
	});

	it("still records status and history for an undrivable engine", async () => {
		const h = makeHarness(makeNote({
			engine: "gpt-5-turbo", queueMode: "auto",
			history: [{ text: "task A", completed: false }],
		}));
		await h.engine.onStopSignal("P-1", "done");
		const saved = h.notes.get("P-1")!;
		assert.equal(saved.status, "idle");
		assert.equal(saved.history[0]!.completed, true);
	});

	it("still sends on an explicit manual sendNext for an undrivable engine", async () => {
		const h = makeHarness(makeNote({ engine: "gpt-5-turbo", queueMode: "manual", queue: ["do it"] }));
		await h.engine.sendNext("P-1");
		assert.equal(h.notes.get("P-1")!.queue.length, 0);
		assert.ok(h.execs.some((a) => a.join(" ").includes("do it")));
	});

	it("ignores a note edit that would auto-send for an undrivable engine", async () => {
		const h = makeHarness(makeNote({ engine: "gpt-5-turbo", status: "idle", queueMode: "auto", queue: ["x"] }));
		await h.engine.onNoteChanged("P-1");
		assert.equal(h.engine.getCountdownRemaining("P-1"), 0);
		assert.equal(h.execs.length, 0);
	});

	it("still auto-sends on a note edit for Claude", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ engine: "claude", status: "idle", queueMode: "auto", queue: ["x"] }), { countdownSeconds: 1 });
		await h.engine.onNoteChanged("P-1");
		assert.equal(h.engine.getCountdownRemaining("P-1"), 1);
		timers(t).tick(1000);
		await h.engine.flush();
		assert.equal(h.notes.get("P-1")!.queue.length, 0);
	});
});

// ---------------------------------------------------------------------------
// Send failure must leave the task retryable and must not double-execute.
// ---------------------------------------------------------------------------

function makeFailingHarness(note: SessionNote, failOn: (args: string[]) => boolean): Harness {
	const h = makeHarness(note);
	const notes = h.notes;
	const execs = h.execs;
	const notifications = h.notifications;
	const failing: Harness = { ...h, engine: null as unknown as QueueEngine };
	failing.engine = new QueueEngine({
		store: {
			read: (s) => Promise.resolve(notes.has(s) ? structuredClone(notes.get(s)!) : null),
			write: (s, n) => { notes.set(s, structuredClone(n)); return Promise.resolve(); },
		},
		exec: (args) => {
			execs.push(args);
			return failOn(args) ? Promise.reject(new Error("tmux: no such session")) : Promise.resolve("");
		},
		notifier: {
			notify: (m) => { notifications.push(m); },
			soundOnAsking: () => {},
		},
		getCountdownSeconds: () => 3,
		playSoundOnAsking: () => false,
		sendKeyDelayMs: 0,
	});
	return failing;
}

const isLiteralSend = (args: string[]): boolean => args[0] === "send-keys" && args.includes("-l");
const isEnterSend = (args: string[]): boolean => args[0] === "send-keys" && args.at(-1) === "Enter";

describe("QueueEngine send failure", () => {
	it("puts the task back at the head of the queue when the text never reached tmux", async () => {
		const h = makeFailingHarness(makeNote({ queue: ["first", "second"] }), isLiteralSend);
		await h.engine.sendNext("P-1");
		const saved = h.notes.get("P-1")!;
		assert.deepStrictEqual(saved.queue, ["first", "second"], "queue restored in order");
		assert.equal(saved.history.length, 0, "no history entry for a task that never ran");
	});

	it("does not leave the session marked running after a failed send", async () => {
		const h = makeFailingHarness(makeNote({ status: "idle", queue: ["x"] }), isLiteralSend);
		await h.engine.sendNext("P-1");
		assert.notEqual(h.notes.get("P-1")!.status, "running");
	});

	it("tells the user the send failed instead of failing silently", async () => {
		const h = makeFailingHarness(makeNote({ queue: ["x"] }), isLiteralSend);
		await h.engine.sendNext("P-1");
		assert.equal(h.notifications.length, 1);
		assert.match(h.notifications[0]!, /fail/i);
	});

	it("sends the task exactly once on a retry after a failure", async () => {
		const h = makeFailingHarness(makeNote({ queue: ["only task"] }), isLiteralSend);
		await h.engine.sendNext("P-1");
		assert.deepStrictEqual(h.notes.get("P-1")!.queue, ["only task"]);
		const literalSends = h.execs.filter(isLiteralSend);
		assert.equal(literalSends.length, 1, "one attempt, not a retry loop");
	});

	it("keeps the task in history when only the Enter keystroke failed", async () => {
		// The text is already sitting in the agent's input box: re-queueing it
		// would type the prompt twice.
		const h = makeFailingHarness(makeNote({ queue: ["x"] }), isEnterSend);
		await h.engine.sendNext("P-1");
		const saved = h.notes.get("P-1")!;
		assert.deepStrictEqual(saved.queue, []);
		assert.equal(saved.history.length, 1);
		assert.match(h.notifications[0]!, /Enter/i);
	});

	it("does nothing at all on an empty queue", async () => {
		const h = makeFailingHarness(makeNote({ queue: [] }), isLiteralSend);
		await h.engine.sendNext("P-1");
		assert.equal(h.execs.filter(isLiteralSend).length, 0);
		assert.equal(h.notifications.length, 0);
	});
});

// ---------------------------------------------------------------------------
// Aborted turns
// ---------------------------------------------------------------------------

describe("QueueEngine error stop signal", () => {
	it("marks the session errored and never advances the queue", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ queueMode: "auto", queue: ["next"], history: [{ text: "current", completed: false }] }));
		await h.engine.onStopSignal("P-1", "error");
		const saved = h.notes.get("P-1")!;
		assert.equal(saved.status, "error");
		assert.equal(saved.history[0]!.completed, false, "the interrupted task is not marked done");
		assert.equal(h.engine.getCountdownRemaining("P-1"), 0);
		timers(t).tick(10000);
		await h.engine.flush();
		assert.deepStrictEqual(h.notes.get("P-1")!.queue, ["next"]);
	});

	it("leaves the session idle so it is not stranded waiting for a Stop", async () => {
		// Codex fires Interrupt instead of Stop — never both. A session left
		// marked running after an interrupt would never recover.
		const h = makeHarness(makeNote({ queueMode: "auto", queue: ["next"] }));
		await h.engine.onStopSignal("P-1", "error");
		assert.equal(h.engine.isIdle("P-1"), true);
	});

	it("holds the queue on the error signal itself, not by faking a running turn", async () => {
		const h = makeHarness(makeNote({ queueMode: "auto", queue: ["next"] }));
		await h.engine.onStopSignal("P-1", "error");
		assert.equal(h.engine.getCountdownRemaining("P-1"), 0);
		assert.equal(h.execs.length, 0);
	});

	it("lets the user resume by queueing new work after an interrupt", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ queueMode: "auto", queue: ["next"] }), { countdownSeconds: 1 });
		await h.engine.onStopSignal("P-1", "error");
		await h.engine.onNoteChanged("P-1");
		timers(t).tick(1000);
		await h.engine.flush();
		assert.deepStrictEqual(h.notes.get("P-1")!.queue, [], "a later edit can resume the queue");
	});

	it("resumes normally once a real turn-end arrives", async (t) => {
		timers(t).enable({ apis: ["setInterval"] });
		const h = makeHarness(makeNote({ queueMode: "auto", queue: ["next"] }), { countdownSeconds: 1 });
		await h.engine.onStopSignal("P-1", "error");
		await h.engine.onStopSignal("P-1", "done");
		timers(t).tick(1000);
		await h.engine.flush();
		assert.deepStrictEqual(h.notes.get("P-1")!.queue, []);
	});
});
