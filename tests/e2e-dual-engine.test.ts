// End-to-end dual-engine test: drives a real Codex TUI inside a real tmux
// session through the real QueueEngine, and feeds the engine's own hook
// output back in. This is the one path unit tests cannot cover — that a
// queued task actually reaches the agent, and that the agent's turn-end
// actually comes back to us as a signal we can act on.
//
// Opt-in: it spends real Codex quota, so `npm run check` does not run it.
// Enable with CO_E2E_CODEX=1 (see the dual-engine operations note).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { QueueEngine } from "../src/queue-engine.ts";
import {
	CODEX_ENGINE,
	engineCommandLine,
	engineHookRegistrations,
	findTmuxBinary,
	parseStopSignal,
	resolveEngineBinary,
	resolveEngineRef,
	StopSignalLedger,
} from "../src/utils.ts";
import type { SessionNote, StopSignal } from "../src/utils.ts";

// @types/node v16 predates import.meta.dirname — narrow it locally.
const HERE = (import.meta as { dirname: string }).dirname;
const SCRIPTS_DIR = join(HERE, "..", "scripts");
const RUN_TAG = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const SESSION = `co-dual-e2e-${RUN_TAG}`;

function have(bin: string): boolean {
	try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

const TMUX = (() => {
	try { const b = findTmuxBinary(); execFileSync(b, ["-V"], { stdio: "ignore" }); return b; } catch { return null; }
})();

const CODEX = resolveEngineBinary(CODEX_ENGINE, homedir(), existsSync);
const AUTH = join(homedir(), ".codex", "auth.json");

const ENABLED = process.env.CO_E2E_CODEX === "1" && TMUX !== null && have(CODEX) && existsSync(AUTH);

function tmux(args: string[]): string {
	return execFileSync(TMUX!, args, { encoding: "utf8" });
}

/** Async form matching production execTmux: a failing tmux call must
 * *reject*, not throw synchronously, or the engine's tolerated-failure
 * paths (`.catch()` on copy-mode cancel) never get a promise to attach to. */
function tmuxAsync(args: string[]): Promise<string> {
	try { return Promise.resolve(tmux(args)); } catch (err) { return Promise.reject(err as Error); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Isolated CODEX_HOME so the run never touches the user's real Codex
 * config, sessions, or hook trust state. */
function setupCodexHome(signalDir: string): string {
	const home = mkdtempSync(join(tmpdir(), "co-e2e-codex-home-"));
	copyFileSync(AUTH, join(home, "auth.json"));
	writeFileSync(join(home, "config.toml"), 'model = "gpt-6-astra"\n');

	const hooks: Record<string, unknown> = {};
	for (const reg of engineHookRegistrations(resolveEngineRef("codex"), SCRIPTS_DIR)) {
		hooks[reg.event] = [{
			matcher: "*",
			hooks: [{ type: "command", command: `'${reg.scriptPath}'`, timeout: 10 }],
		}];
	}
	writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks }, null, 2));
	void signalDir;
	return home;
}

/** Poll the signal directory the way the plugin's watcher does. */
async function awaitSignal(dir: string, timeoutMs: number): Promise<StopSignal | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			const sig = parseStopSignal(readFileSync(join(dir, f), "utf8"));
			if (sig) { rmSync(join(dir, f)); return sig; }
		}
		await sleep(500);
	}
	return null;
}

describe("e2e: a real Codex turn driven by the queue engine", { skip: !ENABLED, concurrency: 1 }, () => {
	it("sends a queued task to Codex and gets a turn-end signal back", async () => {
		const work = mkdtempSync(join(tmpdir(), "co-e2e-work-"));
		const signals = mkdtempSync(join(tmpdir(), "co-e2e-signals-"));
		const codexHome = setupCodexHome(signals);
		mkdirSync(join(work, ".git"), { recursive: true });

		const note: SessionNote = {
			session: SESSION, status: "idle", queueMode: "manual",
			displayName: "", summary: "", engine: "codex", model: "",
			notes: "", history: [], queue: ["Reply with exactly: PROBE_OK"],
		};
		const notes = new Map<string, SessionNote>([[SESSION, note]]);
		const notifications: string[] = [];
		const engine = new QueueEngine({
			store: {
				read: (s) => Promise.resolve(notes.has(s) ? structuredClone(notes.get(s)!) : null),
				write: (s, n) => { notes.set(s, structuredClone(n)); return Promise.resolve(); },
			},
			exec: tmuxAsync,
			notifier: { notify: (m) => { notifications.push(m); }, soundOnAsking: () => {} },
			getCountdownSeconds: () => 0,
			playSoundOnAsking: () => false,
		});

		try {
			tmux(["new-session", "-d", "-s", SESSION, "-c", work, "-x", "100", "-y", "30"]);
			tmux(["set-option", "-t", SESSION, "@co_vault", "e2e"]);
			tmux(["send-keys", "-t", SESSION, "-l",
				`export CODEX_HOME=${codexHome} CO_SIGNAL_DIR=${signals}`]);
			tmux(["send-keys", "-t", SESSION, "Enter"]);
			await sleep(1000);

			const launch = engineCommandLine(CODEX_ENGINE.buildLaunchCommand({ binary: CODEX }));
			tmux(["send-keys", "-t", SESSION, "-l",
				`${launch} --dangerously-bypass-hook-trust -s read-only`]);
			tmux(["send-keys", "-t", SESSION, "Enter"]);

			// First run in a fresh directory asks whether the directory is
			// trusted; the default answer is "yes, continue".
			await sleep(6000);
			if (tmux(["capture-pane", "-p", "-t", SESSION]).includes("Do you trust")) {
				tmux(["send-keys", "-t", SESSION, "Enter"]);
			}
			await sleep(8000);
			assert.match(tmux(["capture-pane", "-p", "-t", SESSION]), /Ask Codex/, "TUI reached its prompt");

			// The production send path, not a hand-rolled one.
			await engine.sendNext(SESSION);
			assert.deepStrictEqual(notes.get(SESSION)!.queue, [], "task left the queue");
			assert.equal(notes.get(SESSION)!.history.length, 1, "task recorded in history");
			assert.equal(notes.get(SESSION)!.status, "running");

			const signal = await awaitSignal(signals, 120_000);
			assert.notEqual(signal, null, "Codex Stop hook produced a signal");
			assert.equal(signal!.provider, "codex", "signal is attributed to Codex, not Claude");
			assert.equal(signal!.tmuxSession, SESSION);
			assert.ok(signal!.turnId, "Codex supplies a turn id for correlation");
			assert.equal(signal!.stopReason, "done");

			// A redelivery of the same event must not act twice.
			const ledger = new StopSignalLedger();
			assert.equal(ledger.accept(signal!), true);
			assert.equal(ledger.accept(signal!), false);

			await engine.onStopSignal(SESSION, signal!.stopReason ?? "done");
			const after = notes.get(SESSION)!;
			assert.equal(after.status, "idle", "turn-end marks the session idle");
			assert.equal(after.history[0]!.completed, true, "the sent task is marked done");
			assert.match(tmux(["capture-pane", "-p", "-t", SESSION]), /PROBE_OK/, "Codex actually answered");
		} finally {
			try { tmux(["kill-session", "-t", SESSION]); } catch { /* already gone */ }
			rmSync(work, { recursive: true, force: true });
			rmSync(signals, { recursive: true, force: true });
			rmSync(codexHome, { recursive: true, force: true });
		}
	});
});
