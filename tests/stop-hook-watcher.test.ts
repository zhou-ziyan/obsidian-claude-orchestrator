import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StopHookWatcher } from "../src/stop-hook-watcher.ts";

function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const timer = setInterval(() => {
			if (predicate()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				reject(new Error("timed out"));
			}
		}, 5);
	});
}

describe("StopHookWatcher polling and vault isolation", () => {
	it("polling drains a signal when fs.watch never reports it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "co-watch-poll-"));
		const seen: string[] = [];
		const watcher = new StopHookWatcher(
			() => ({ P: { vaultFolder: "P" } }),
			() => "Work",
			{ signalDir: dir, pollMs: 10, watch: () => ({ close() {} }) },
		);
		watcher.onSignal((signal) => seen.push(signal.tmuxSession));
		watcher.start();
		try {
			writeFileSync(join(dir, "missed.json"), JSON.stringify({
				tmux_session: "P-1", timestamp: 1, vault: "Work", provider: "claude", stop_reason: "done",
			}));
			await waitFor(() => seen.length === 1);
			assert.deepStrictEqual(seen, ["P-1"]);
		} finally {
			watcher.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("one vault cannot consume or delete another vault's signal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "co-watch-vault-"));
		const workSeen: string[] = [];
		const lifeSeen: string[] = [];
		const noWatch = { signalDir: dir, pollMs: 10, watch: () => ({ close() {} }) };
		const work = new StopHookWatcher(() => ({ P: { vaultFolder: "P" } }), () => "Work", noWatch);
		const life = new StopHookWatcher(() => ({ P: { vaultFolder: "P" } }), () => "Life", noWatch);
		work.onSignal((signal) => workSeen.push(signal.tmuxSession));
		life.onSignal((signal) => lifeSeen.push(signal.tmuxSession));
		work.start();
		try {
			writeFileSync(join(dir, "life.json"), JSON.stringify({
				tmux_session: "P-1", timestamp: 1, vault: "Life", provider: "codex", stop_reason: "done",
			}));
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.deepStrictEqual(workSeen, []);
			life.start();
			await waitFor(() => lifeSeen.length === 1);
			assert.deepStrictEqual(lifeSeen, ["P-1"]);
		} finally {
			work.stop();
			life.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
