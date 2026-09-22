// End-to-end tests against a real tmux server through node-pty — the exact
// path the plugin uses. These cover the plugin↔tmux seam that unit tests
// can't: mouse-mode scrolling, copy-mode paging, and PTY-driven resizing.
// Skipped when tmux isn't installed (e.g. CI runners).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import {
	buildTmuxSessionArgs,
	ensureTmuxUtf8Locale,
	findTmuxBinary,
	isUtf8Locale,
	parseTmuxGlobalEnvValue,
	tmuxPageArgs,
} from "../src/utils.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
// @types/node v16 predates node:test's `after` — type it from the module.
const { after } = require("node:test") as { after: (fn: () => void) => void };

// Session names must be unique per process: several worktrees run
// `npm run check` at once, and attachSession() kills its session name on
// entry and exit — a fixed name lets one run tear down another's server
// session mid-test, which looks like flaky tmux rather than a collision.
const RUN_TAG = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

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
	const SESSION = `co-e2e-scroll-${RUN_TAG}`;
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
	const SESSION = `co-e2e-resize-${RUN_TAG}`;
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

// ---------------------------------------------------------------------------
// e2e: clipboard encoding through tmux's copy-pipe job
//
// `~/.tmux.conf` binds drag-select to `copy-pipe-and-cancel "pbcopy"`. tmux
// forks that command as a *job*, which inherits the tmux SERVER environment —
// not the pane's. A server started by launchd (lighthouse does exactly this)
// has no LANG/LC_* and only `__CF_USER_TEXT_ENCODING=<uid>:0x0:0x0`; 0x0 is
// kCFStringEncodingMacRoman, so pbcopy decodes UTF-8 stdin as MacRoman and
// 我会 (e6 88 91 e4 bc 9a) reaches the clipboard as Êàë‰ºö.
//
// These tests run against a private tmux server (`-L`) started with a
// launchd-shaped environment, so they reproduce the broken server without
// touching the user's real sessions.
// ---------------------------------------------------------------------------

describe("e2e: tmux job environment carries a UTF-8 locale", { skip: !TMUX, concurrency: 1 }, () => {
	const SOCKET = `co-e2e-locale-${RUN_TAG}`;
	const SESSION = "probe";
	const CJK = "我会核对";
	let tmpDir: string;

	// A launchd-shaped environment: no LANG, no LC_*, CF text encoding = MacRoman.
	const launchdEnv = {
		HOME: os.homedir(),
		PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
		SHELL: "/bin/zsh",
		__CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
	};

	const onSocket = (args: string[]) =>
		execFileSync(TMUX!, ["-L", SOCKET, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();

	const quiet = (args: string[]) => { try { onSocket(args); } catch { /* best effort */ } };
	const pause = (seconds: string) => execFileSync("/bin/sleep", [seconds]);

	after(() => {
		quiet(["kill-server"]);
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	// What a `copy-pipe` job sees: run-shell goes through the same job
	// mechanism, so dumping its environment is a faithful probe.
	const jobLang = (): string | null => {
		const out = path.join(tmpDir, `env-${Math.random().toString(36).slice(2)}.txt`);
		onSocket(["run-shell", `sh -c 'printenv LANG > ${out}; true'`]);
		for (let i = 0; i < 40; i++) {
			try {
				return readFileSync(out, "utf8").trim() || null;
			} catch {
				pause("0.05");
			}
		}
		return null;
	};

	it("reproduces the broken server: a launchd-started tmux has no LANG in its jobs", () => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "co-e2e-locale-"));
		quiet(["kill-server"]);
		execFileSync(TMUX!, ["-L", SOCKET, "new-session", "-d", "-s", SESSION], {
			env: launchdEnv,
			stdio: "ignore",
		});
		assert.equal(
			parseTmuxGlobalEnvValue(onSocket(["show-environment", "-g"]), "LANG"),
			null,
			"precondition: server global env has no LANG",
		);
		assert.equal(jobLang(), null, "precondition: copy-pipe jobs inherit no LANG");
	});

	it("ensureTmuxUtf8Locale installs a UTF-8 LANG that reaches job processes", async () => {
		const fixed = await ensureTmuxUtf8Locale((args) => Promise.resolve(onSocket(args)), {});
		assert.equal(fixed, true, "reported that it repaired the environment");
		const lang = jobLang();
		assert.ok(isUtf8Locale(lang), `copy-pipe jobs now see a UTF-8 LANG (got ${lang})`);
	});

	it("is idempotent and does not clobber a locale that is already UTF-8", async () => {
		onSocket(["set-environment", "-g", "LANG", "zh_CN.UTF-8"]);
		const fixed = await ensureTmuxUtf8Locale((args) => Promise.resolve(onSocket(args)), {});
		assert.equal(fixed, false, "left the existing UTF-8 locale untouched");
		assert.equal(jobLang(), "zh_CN.UTF-8");
	});

	it("tmux copy-pipe is byte-transparent for CJK (the mangling is pbcopy's decode, not tmux's)", () => {
		const src = path.join(tmpDir, "cjk.txt");
		const sink = path.join(tmpDir, "copied.bin");
		writeFileSync(src, CJK + "\n", "utf8");

		onSocket(["send-keys", "-t", SESSION, `clear; cat ${src}`, "Enter"]);
		pause("1");

		// Locate the CJK row rather than guessing how many lines the prompt
		// spans: capture-pane rows and #{cursor_y} share a 0-based origin at
		// the top of the visible pane.
		const rows = onSocket(["capture-pane", "-p", "-t", SESSION]).split("\n");
		const row = rows.findIndex((l) => l.includes(CJK));
		assert.ok(row >= 0, `pane rendered the CJK line (pane: ${JSON.stringify(rows)})`);
		const cursorY = Number(onSocket(["display-message", "-p", "-t", SESSION, "#{cursor_y}"]));

		onSocket(["copy-mode", "-t", SESSION]);
		for (let i = row; i < cursorY; i++) onSocket(["send-keys", "-t", SESSION, "-X", "cursor-up"]);
		onSocket(["send-keys", "-t", SESSION, "-X", "select-line"]);
		onSocket(["send-keys", "-t", SESSION, "-X", "copy-pipe-and-cancel", `cat > ${sink}`]);
		pause("1");

		const copied = readFileSync(sink);
		assert.ok(
			copied.includes(Buffer.from(CJK, "utf8")),
			`copy-pipe delivered raw UTF-8 bytes (got ${copied.toString("hex")})`,
		);
	});
});

// The real pbcopy round-trip overwrites the user's system clipboard, so it is
// opt-in rather than part of `npm run check`:
//   CO_E2E_CLIPBOARD=1 npm run test:e2e
describe("e2e: pbcopy round-trip", {
	skip: !TMUX || process.env.CO_E2E_CLIPBOARD !== "1",
	concurrency: 1,
}, () => {
	const SOCKET = `co-e2e-pb-${RUN_TAG}`;
	const CJK = "我会核对";

	const onSocket = (args: string[]) =>
		execFileSync(TMUX!, ["-L", SOCKET, ...args], { encoding: "utf8" }).trim();

	after(() => { try { onSocket(["kill-server"]); } catch { /* gone */ } });

	const pipeThroughPbcopy = (): string => {
		const b64 = Buffer.from(CJK, "utf8").toString("base64");
		onSocket(["run-shell", `sh -c 'printf %s ${b64} | base64 -d | pbcopy'`]);
		execFileSync("/bin/sleep", ["1"]);
		return execFileSync("/usr/bin/pbpaste", { encoding: "utf8" });
	};

	it("mangles CJK on a launchd-shaped server, and is fixed by ensureTmuxUtf8Locale", async () => {
		execFileSync(TMUX!, ["-L", SOCKET, "new-session", "-d", "-s", "probe"], {
			env: {
				HOME: os.homedir(),
				PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
				SHELL: "/bin/zsh",
				__CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
			},
		});
		assert.notEqual(pipeThroughPbcopy(), CJK, "precondition: clipboard is mojibake");

		await ensureTmuxUtf8Locale((args) => Promise.resolve(onSocket(args)), {});
		assert.equal(pipeThroughPbcopy(), CJK, "clipboard now round-trips UTF-8");
	});
});
