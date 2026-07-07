// End-to-end tests against a real tmux server through node-pty — the exact
// path the plugin uses. These cover the plugin↔tmux seam that unit tests
// can't: mouse-mode scrolling, copy-mode paging, and PTY-driven resizing.
// Skipped when tmux isn't installed (e.g. CI runners).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import { buildTmuxSessionArgs, findTmuxBinary, tmuxPageArgs } from "../src/utils.ts";

const require = createRequire(import.meta.url);
// @types/node v16 predates node:test's `after` — type it from the module.
const { after } = require("node:test") as { after: (fn: () => void) => void };

function detectTmux(): string | null {
	try {
		const bin = findTmuxBinary();
		execFileSync(bin, ["-V"], { stdio: "ignore" });
		return bin;
	} catch {
		return null;
	}
}

const TMUX = detectTmux();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PtySession {
	proc: import("node-pty").IPty;
	output: () => string;
	tmux: (args: string[]) => string;
	kill: () => void;
}

function attachSession(sessionName: string, cols: number, rows: number): PtySession {
	const pty = require("node-pty") as typeof import("node-pty");
	const tmux = (args: string[]) => execFileSync(TMUX!, args, { encoding: "utf8" }).trim();
	try { tmux(["kill-session", "-t", sessionName]); } catch { /* not running */ }

	let output = "";
	const proc = pty.spawn(TMUX!, buildTmuxSessionArgs(sessionName, "e2e-vault"), {
		name: "xterm-256color", cols, rows,
		cwd: os.homedir(),
		env: process.env as { [key: string]: string },
	});
	proc.onData((d) => { output += d; });

	return {
		proc,
		output: () => output,
		tmux,
		kill: () => {
			try { tmux(["kill-session", "-t", sessionName]); } catch { /* gone */ }
			try { proc.kill(); } catch { /* gone */ }
		},
	};
}

describe("e2e: native mouse scrolling through the PTY", { skip: !TMUX, concurrency: 1 }, () => {
	const SESSION = "co-e2e-scroll";
	let s: PtySession;

	after(() => { s?.kill(); });

	const paneState = () => s.tmux(["display-message", "-p", "-t", SESSION, "#{pane_in_mode} #{scroll_position}"]);

	it("attach requests mouse reporting and applies session options", async () => {
		s = attachSession(SESSION, 80, 12);
		await sleep(800);
		assert.ok(s.output().includes("\x1b[?1000h"), "mouse tracking requested");
		assert.ok(s.output().includes("\x1b[?1006h"), "SGR encoding requested");
		assert.equal(s.tmux(["show-options", "-t", SESSION, "mouse"]), "mouse on");
		assert.equal(s.tmux(["show-options", "-w", "-t", SESSION, "window-size"]), "window-size latest");
	});

	it("SGR wheel-up (what xterm emits) enters copy-mode and scrolls history", async () => {
		s.proc.write("seq 1 300\r");
		await sleep(600);
		for (let i = 0; i < 3; i++) s.proc.write("\x1b[<64;10;5M");
		await sleep(400);
		const [inMode, pos] = paneState().split(" ").map(Number);
		assert.equal(inMode, 1, "copy-mode entered");
		assert.ok(pos! > 0, `scrolled into history (position ${pos})`);
	});

	it("tmuxPageArgs pages up while already in copy-mode", async () => {
		const before = Number(paneState().split(" ")[1]);
		s.tmux(tmuxPageArgs(SESSION, "up"));
		await sleep(200);
		const afterPos = Number(paneState().split(" ")[1]);
		assert.ok(afterPos > before, `${before} -> ${afterPos}`);
	});

	it("wheel-down returns to the bottom and exits copy-mode", async () => {
		for (let i = 0; i < 60; i++) s.proc.write("\x1b[<65;10;5M");
		await sleep(500);
		assert.equal(Number(paneState().split(" ")[0]), 0, "copy-mode exited at bottom");
	});
});

describe("e2e: PTY-driven window sizing", { skip: !TMUX, concurrency: 1 }, () => {
	const SESSION = "co-e2e-resize";
	let s: PtySession;

	after(() => { s?.kill(); });

	const winSize = () => s.tmux(["display-message", "-p", "-t", SESSION, "#{window_width}x#{window_height}"]);

	it("attach heals a legacy manual-sized window and adopts the client size", async () => {
		// Poison exactly like pre-1.1.9 plugin versions did.
		execFileSync(TMUX!, ["new-session", "-d", "-s", SESSION, "-x", "70", "-y", "18"]);
		execFileSync(TMUX!, ["resize-window", "-t", SESSION, "-x", "60", "-y", "15"]);
		s = attachSession(SESSION, 80, 20);
		await sleep(800);
		assert.equal(s.tmux(["show-options", "-w", "-t", SESSION, "window-size"]), "window-size latest");
		assert.equal(winSize(), "80x20");
	});

	it("pty.resize alone drives the tmux window in both directions", async () => {
		s.proc.resize(110, 35);
		await sleep(500);
		assert.equal(winSize(), "110x35");
		s.proc.resize(64, 16);
		await sleep(500);
		assert.equal(winSize(), "64x16");
	});

	it("content rewraps at the new width", async () => {
		s.proc.write("clear; printf 'X%.0s' {1..100}; echo\r");
		await sleep(500);
		const lines = s.tmux(["capture-pane", "-p", "-t", SESSION]).split("\n").filter((l) => l.includes("X"));
		assert.equal(lines.length, 2, "100 chars wrap into 2 lines at 64 cols");
		assert.equal(lines[0]!.length, 64);
	});
});
