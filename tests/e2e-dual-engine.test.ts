// End-to-end dual-engine tests: real tmux, real agent CLIs, real hook
// scripts, real QueueEngine. This is the seam unit tests cannot reach —
// that a queued task actually lands in the agent, that the agent's own
// hooks come back to us, and that the queue advances (or refuses to) for
// the right reason.
//
// Opt-in: these spend real Claude and Codex quota, so `npm run check` does
// not run them. Enable with:
//
//     CO_E2E_CODEX=1 npm run test:e2e:codex
//
// Everything runs isolated: a temporary CODEX_HOME, a temporary settings
// file for Claude, a temporary signal directory, and pid-unique tmux
// session names tagged with a vault name no real vault uses — so a running
// plugin never consumes these signals and the user's own config is never
// touched.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	copyFileSync, existsSync, mkdirSync, mkdtempSync,
	readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { QueueEngine } from "../src/queue-engine.ts";
import {
	autoSendAction,
	CLAUDE_ENGINE,
	CODEX_ENGINE,
	engineHookRegistrations,
	findTmuxBinary,
	parseStopSignal,
	resolveEngineBinary,
	resolveEngineRef,
	stopSignalKey,
	StopSignalLedger,
} from "../src/utils.ts";
import type { EngineDefinition, SessionNote, StopSignal } from "../src/utils.ts";
import { claudeLaunchLine, codexLaunchLine, codexResumeLine } from "./engine-cli.ts";

// @types/node v16 predates import.meta.dirname — narrow it locally.
const HERE = (import.meta as { dirname: string }).dirname;
const SCRIPTS_DIR = join(HERE, "..", "scripts");
const RUN_TAG = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
/** No real vault is called this, so a running plugin ignores our signals. */
const E2E_VAULT = `co-e2e-${RUN_TAG}`;

const TMUX = (() => {
	try { const b = findTmuxBinary(); execFileSync(b, ["-V"], { stdio: "ignore" }); return b; } catch { return null; }
})();

function binaryFor(engine: EngineDefinition): string | null {
	const bin = resolveEngineBinary(engine, homedir(), existsSync);
	try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return bin; } catch { return null; }
}

const CODEX = TMUX ? binaryFor(CODEX_ENGINE) : null;
const CLAUDE = TMUX ? binaryFor(CLAUDE_ENGINE) : null;
const CODEX_AUTH = join(homedir(), ".codex", "auth.json");

const OPTED_IN = process.env.CO_E2E_CODEX === "1";
const CODEX_READY = OPTED_IN && CODEX !== null && existsSync(CODEX_AUTH);
const CLAUDE_READY = OPTED_IN && CLAUDE !== null;

function tmux(args: string[]): string {
	return execFileSync(TMUX!, args, { encoding: "utf8" });
}

/**
 * Kill sessions left behind by an interrupted run. A test process that is
 * stopped never reaches its `finally`, and the orphan then shows up in the
 * user's Session Manager under Unmanaged.
 */
function sweepOrphanSessions(): void {
	if (!TMUX) return;
	let listing = "";
	try { listing = tmux(["ls", "-F", "#{session_name}"]); } catch { return; }
	for (const name of listing.split("\n").map((l) => l.trim())) {
		if (!name.startsWith("co-e2e-")) continue;
		if (name.endsWith(RUN_TAG)) continue; // ours, still running
		try { tmux(["kill-session", "-t", name]); } catch { /* already gone */ }
	}
}

/** Production execTmux is async: a failure must reject, not throw, or the
 * engine's tolerated-failure paths have no promise to attach to. */
function tmuxAsync(args: string[]): Promise<string> {
	try { return Promise.resolve(tmux(args)); } catch (err) { return Promise.reject(err as Error); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pane(session: string): string {
	try { return tmux(["capture-pane", "-p", "-t", session]); } catch { return ""; }
}

async function waitForPane(session: string, needle: RegExp, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (needle.test(pane(session))) return true;
		await sleep(500);
	}
	return false;
}

/**
 * Answer Claude's workspace-trust prompt.
 *
 * The prompt defaults to "No, exit" with "Yes, I trust this folder" one line
 * below. Waiting on the explanatory paragraph is a race: that text paints
 * before the option list is interactive, so a Down sent on sight of it can
 * land before there is a list to move, leaving the cursor on "No, exit" —
 * Enter then drops straight back to the shell with the task never sent.
 * Wait for the option itself, then confirm the marker actually moved.
 */
async function trustWorkspace(session: string, timeoutMs = 30_000): Promise<boolean> {
	if (!await waitForPane(session, /Yes, I trust this folder/, timeoutMs)) return false;
	const selectedYes = /❯\s*Yes, I trust this folder/;
	for (let attempt = 0; attempt < 5 && !selectedYes.test(pane(session)); attempt++) {
		tmux(["send-keys", "-t", session, "Down"]);
		await sleep(400);
	}
	assert.match(pane(session), selectedYes, "trust prompt is on the trusting option before Enter");
	tmux(["send-keys", "-t", session, "Enter"]);
	return true;
}

async function awaitSignal(dir: string, timeoutMs: number, reason?: StopSignal["stopReason"]): Promise<StopSignal | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
		for (const f of files) {
			const path = join(dir, f);
			let sig: StopSignal | null = null;
			try { sig = parseStopSignal(readFileSync(path, "utf8")); } catch { /* mid-write */ }
			if (sig && (reason === undefined || sig.stopReason === reason)) {
				rmSync(path, { force: true });
				return sig;
			}
		}
		await sleep(400);
	}
	return null;
}

interface Rig {
	session: string;
	engine: QueueEngine;
	notes: Map<string, SessionNote>;
	notifications: string[];
	signals: string;
	cleanup: () => void;
}

function makeRig(sessionName: string, note: Partial<SessionNote>, dirs: string[]): Rig {
	const signals = mkdtempSync(join(tmpdir(), "co-e2e-signals-"));
	const notes = new Map<string, SessionNote>([[sessionName, {
		session: sessionName, status: "idle", queueMode: "manual",
		displayName: "", summary: "", engine: "", model: "",
		notes: "", history: [], queue: [], ...note,
	}]]);
	const notifications: string[] = [];
	const engine = new QueueEngine({
		store: {
			read: (s) => Promise.resolve(notes.has(s) ? structuredClone(notes.get(s)!) : null),
			write: (s, n) => { notes.set(s, structuredClone(n)); return Promise.resolve(); },
		},
		exec: tmuxAsync,
		notifier: { notify: (m) => { notifications.push(m); }, soundOnAsking: () => {} },
		getCountdownSeconds: () => 0,
		idleStabilityMs: 100,
		playSoundOnAsking: () => false,
	});
	return {
		session: sessionName, engine, notes, notifications, signals,
		cleanup: () => {
			engine.dispose();
			try { tmux(["kill-session", "-t", sessionName]); } catch { /* already gone */ }
			for (const d of [signals, ...dirs]) rmSync(d, { recursive: true, force: true });
		},
	};
}

function startTmux(session: string, cwd: string, env: Record<string, string>): void {
	sweepOrphanSessions();
	tmux(["new-session", "-d", "-s", session, "-c", cwd, "-x", "110", "-y", "32"]);
	tmux(["set-option", "-t", session, "@co_vault", E2E_VAULT]);
	const exports = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ");
	tmux(["send-keys", "-t", session, "-l", `export ${exports}`]);
	tmux(["send-keys", "-t", session, "Enter"]);
}

function typeLine(session: string, line: string): void {
	tmux(["send-keys", "-t", session, "-l", line]);
	tmux(["send-keys", "-t", session, "Enter"]);
}

/** Isolated CODEX_HOME carrying only auth plus the hooks under test. */
function setupCodexHome(): string {
	const home = mkdtempSync(join(tmpdir(), "co-e2e-codex-home-"));
	copyFileSync(CODEX_AUTH, join(home, "auth.json"));
	writeFileSync(join(home, "config.toml"), 'model = "gpt-6-astra"\n');
	const hooks: Record<string, unknown> = {};
	for (const reg of engineHookRegistrations(resolveEngineRef("codex"), SCRIPTS_DIR)) {
		hooks[reg.event] = [{ matcher: "*", hooks: [{ type: "command", command: `'${reg.scriptPath}'`, timeout: 10 }] }];
	}
	writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks }, null, 2));
	return home;
}

/** Extra settings file wiring Claude's hooks to the scripts under test. */
function setupClaudeSettings(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "co-e2e-claude-"));
	const hooks: Record<string, unknown> = {};
	for (const reg of engineHookRegistrations(resolveEngineRef("claude"), SCRIPTS_DIR)) {
		hooks[reg.event] = [{ matcher: "*", hooks: [{ type: "command", command: `'${reg.scriptPath}'`, timeout: 10 }] }];
	}
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify({ hooks }, null, 2));
	return { dir, path };
}

function workDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "co-e2e-work-"));
	mkdirSync(join(dir, ".git"), { recursive: true });
	return dir;
}

async function launchCodex(session: string, extraFlags: string): Promise<void> {
	const launch = codexLaunchLine(CODEX!);
	typeLine(session, `${launch} --dangerously-bypass-hook-trust ${extraFlags}`);
	// A fresh directory prompts for trust; the default answer is "yes".
	if (await waitForPane(session, /Do you trust/, 12_000)) {
		tmux(["send-keys", "-t", session, "Enter"]);
	}
	assert.ok(await waitForPane(session, /Ask Codex/, 30_000), "Codex TUI reached its prompt");
	// The composer accepts text as soon as it is painted, but drops the
	// submit keystroke for a moment while the TUI finishes starting. Let it
	// settle before anything is sent, or the prompt sits in the box unsent.
	await sleep(3000);
}


// ---------------------------------------------------------------------------

describe("e2e: Codex through the queue engine", { skip: !CODEX_READY, concurrency: 1 }, () => {
	it("drains a two-item queue: send → turn-end → next item, with no duplicates", async () => {
		const session = `co-e2e-codex-${RUN_TAG}`;
		const codexHome = setupCodexHome();
		const work = workDir();
		const rig = makeRig(session, {
			engine: "codex",
			queueMode: "auto",
			queue: ["Reply with exactly: FIRST_OK", "Reply with exactly: SECOND_OK"],
		}, [codexHome, work]);

		try {
			startTmux(session, work, { CODEX_HOME: codexHome, CO_SIGNAL_DIR: rig.signals });
			await sleep(800);
			await launchCodex(session, "-s read-only");

			// --- item 1 ---
			await rig.engine.sendNext(session);
			assert.equal(rig.notes.get(session)!.queue.length, 1, "one item left queued");

			const firstStart = await awaitSignal(rig.signals, 30_000, "started");
			assert.equal(firstStart?.stopReason, "started", "UserPromptSubmit disarms Queue");
			await rig.engine.onLifecycleSignal(session, "started", "codex", stopSignalKey(firstStart));

			const first = await awaitSignal(rig.signals, 150_000, "done");
			assert.notEqual(first, null, "turn-end signal for item 1");
			assert.equal(first!.provider, "codex");
			assert.equal(first!.stopReason, "done");
			assert.ok(first!.turnId, "Codex supplies a turn id");
			assert.ok(await waitForPane(session, /FIRST_OK/, 5_000), "Codex answered item 1");

			const ledger = new StopSignalLedger();
			assert.equal(ledger.accept(first!), true);
			assert.equal(ledger.accept(first!), false, "a redelivered signal is dropped");

			// --- auto-send drains item 2 ---
			await rig.engine.onLifecycleSignal(session, "done", "codex", stopSignalKey(first!));
			await sleep(150);
			await rig.engine.flush();
			assert.equal(rig.notes.get(session)!.queue.length, 0, "auto mode sent the next item");

			const secondStart = await awaitSignal(rig.signals, 30_000, "started");
			assert.equal(secondStart?.stopReason, "started");
			await rig.engine.onLifecycleSignal(session, "started", "codex", stopSignalKey(secondStart));
			const second = await awaitSignal(rig.signals, 150_000, "done");
			assert.notEqual(second, null, "turn-end signal for item 2");
			assert.notEqual(second!.turnId, first!.turnId, "a distinct turn, not a replay");
			await rig.engine.onLifecycleSignal(session, "done", "codex", stopSignalKey(second!));
			await sleep(150);

			const final = rig.notes.get(session)!;
			assert.deepStrictEqual(final.queue, []);
			assert.equal(final.history.length, 2, "each task recorded exactly once");
			assert.equal(final.history.filter((h) => h.completed).length, 2);
			assert.equal(final.status, "idle");
			assert.ok(await waitForPane(session, /SECOND_OK/, 10_000), "Codex answered item 2");
		} finally {
			rig.cleanup();
		}
	});

	it("does not advance the queue while Codex waits on an approval prompt", async () => {
		const session = `co-e2e-codex-ask-${RUN_TAG}`;
		const codexHome = setupCodexHome();
		const work = workDir();
		const rig = makeRig(session, {
			engine: "codex", queueMode: "auto",
			queue: ["Create a file named blocked.txt containing HELLO", "Reply with exactly: SHOULD_NOT_RUN"],
		}, [codexHome, work]);

		try {
			startTmux(session, work, { CODEX_HOME: codexHome, CO_SIGNAL_DIR: rig.signals });
			await sleep(800);
			// read-only sandbox with on-request approval: a write must ask.
			await launchCodex(session, "-s read-only -a on-request");

			await rig.engine.sendNext(session);

			const started = await awaitSignal(rig.signals, 30_000, "started");
			assert.equal(started?.stopReason, "started");
			await rig.engine.onLifecycleSignal(session, "started", "codex", stopSignalKey(started));
			const signal = await awaitSignal(rig.signals, 150_000, "asking");
			assert.notEqual(signal, null, `a signal arrived while blocked. Pane was:\n${pane(session)}`);
			assert.equal(signal!.provider, "codex");
			assert.equal(signal!.stopReason, "asking", "PermissionRequest maps to asking, not done");

			await rig.engine.onLifecycleSignal(session, "asking", "codex", stopSignalKey(signal!));
			const note = rig.notes.get(session)!;
			assert.equal(note.status, "waiting_for_user");
			assert.deepStrictEqual(note.queue, ["Reply with exactly: SHOULD_NOT_RUN"],
				"the next task must not be typed into a session sitting on an approval prompt");
			assert.equal(autoSendAction(note.queueMode, "asking", note.queue.length), "none");
			assert.ok(!pane(session).includes("SHOULD_NOT_RUN"), "nothing was typed past the prompt");
		} finally {
			rig.cleanup();
		}
	});

	it("resumes an existing conversation by its own session id", async () => {
		const session = `co-e2e-codex-resume-${RUN_TAG}`;
		const codexHome = setupCodexHome();
		const work = workDir();
		const rig = makeRig(session, { engine: "codex", queue: ["Reply with exactly: RESUME_SEED"] }, [codexHome, work]);

		try {
			startTmux(session, work, { CODEX_HOME: codexHome, CO_SIGNAL_DIR: rig.signals });
			await sleep(800);
			await launchCodex(session, "-s read-only");

			await rig.engine.sendNext(session);
			const started = await awaitSignal(rig.signals, 30_000, "started");
			assert.equal(started?.stopReason, "started");
			await rig.engine.onLifecycleSignal(session, "started", "codex", stopSignalKey(started));
			const signal = await awaitSignal(rig.signals, 150_000, "done");
			assert.notEqual(signal, null, `seed turn produced a signal. Pane was:\n${pane(session)}`);
			const conversationId = signal!.sessionId;
			assert.ok(conversationId, "the turn-end names the conversation");

			// Leave the TUI and come back to the same conversation.
			tmux(["send-keys", "-t", session, "C-c"]);
			await sleep(700);
			tmux(["send-keys", "-t", session, "C-c"]);
			await sleep(2000);

			const resume = codexResumeLine(CODEX!, conversationId);
			assert.match(resume, / resume /, "resume command is built, not improvised");
			typeLine(session, `${resume} --dangerously-bypass-hook-trust -s read-only`);
			if (await waitForPane(session, /Do you trust/, 12_000)) {
				tmux(["send-keys", "-t", session, "Enter"]);
			}
			assert.ok(await waitForPane(session, /Ask Codex/, 40_000),
				`resumed TUI came back up:\n${pane(session)}`);
			assert.ok(!/unexpected argument|error: /i.test(pane(session)),
				`resume produced no CLI error:\n${pane(session)}`);
		} finally {
			rig.cleanup();
		}
	});
});

describe("e2e: Claude through the queue engine", { skip: !CLAUDE_READY, concurrency: 1 }, () => {
	it("sends a queued task and advances on the Stop hook", async () => {
		const session = `co-e2e-claude-${RUN_TAG}`;
		const claude = setupClaudeSettings();
		const work = workDir();
		const rig = makeRig(session, {
			engine: "claude", queueMode: "manual", queue: ["Reply with exactly: CLAUDE_OK"],
		}, [claude.dir, work]);

		try {
			startTmux(session, work, { CO_SIGNAL_DIR: rig.signals });
			await sleep(800);
			const launch = claudeLaunchLine(CLAUDE!);
			typeLine(session, `${launch} --settings ${claude.path} --permission-mode plan`);
			await trustWorkspace(session);
			// The ready TUI shows its mode footer under the input box.
			assert.ok(await waitForPane(session, /shift\+tab to cycle|plan mode on/, 60_000),
				`Claude TUI reached its prompt:\n${pane(session)}`);
			// Same settling window as Codex: the composer paints before it
			// starts honoring the submit keystroke.
			await sleep(3000);

			await rig.engine.sendNext(session);
			assert.deepStrictEqual(rig.notes.get(session)!.queue, [], "task left the queue");

			const started = await awaitSignal(rig.signals, 30_000, "started");
			assert.equal(started?.stopReason, "started", "Claude UserPromptSubmit disarms Queue");
			await rig.engine.onLifecycleSignal(session, "started", "claude", stopSignalKey(started));
			const signal = await awaitSignal(rig.signals, 180_000, "done");
			assert.notEqual(signal, null, "Claude's Stop hook produced a signal");
			assert.equal(signal!.provider, "claude", "untagged signals are attributed to Claude");
			assert.equal(signal!.turnId, null, "Claude supplies no turn id — correlation falls back to session id");

			await rig.engine.onLifecycleSignal(session, signal!.stopReason ?? "done", "claude", stopSignalKey(signal!));
			await sleep(150);
			const note = rig.notes.get(session)!;
			assert.equal(note.history.length, 1);
			assert.notEqual(note.status, "running");
		} finally {
			rig.cleanup();
		}
	});
});
