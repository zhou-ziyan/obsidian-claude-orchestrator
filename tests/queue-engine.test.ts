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
