import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildWorkerLaunchArgs,
	buildWorkerLaunchLine,
	launchWorkerSession,
	parseWorkerSessions,
	workerLaunchPreflight,
} from "../src/worker-launch.ts";

describe("worker launch policy", () => {
	it("uses the measured explicit bypass flags per engine", () => {
		assert.deepEqual(
			buildWorkerLaunchArgs("claude", "/opt/homebrew/bin/claude", "bypass", "/work/tree"),
			["/opt/homebrew/bin/claude", "--dangerously-skip-permissions", "--add-dir", "/work/tree"],
		);
		assert.deepEqual(
			buildWorkerLaunchArgs("codex", "/Applications/ChatGPT.app/Contents/Resources/codex", "bypass", "/work/tree"),
			[
				"/Applications/ChatGPT.app/Contents/Resources/codex",
				"--dangerously-bypass-approvals-and-sandbox",
				"--dangerously-bypass-hook-trust",
				"-C", "/work/tree",
			],
		);
	});

	it("keeps prompt mode explicit and shell-quotes the target", () => {
		assert.deepEqual(buildWorkerLaunchArgs("codex", "codex", "prompt", "/work/tree"), [
			"codex", "-a", "on-request", "-s", "workspace-write", "-C", "/work/tree",
		]);
		assert.equal(
			buildWorkerLaunchLine("claude", "/opt/homebrew/bin/claude", "bypass", "/work tree"),
			"/opt/homebrew/bin/claude --dangerously-skip-permissions --add-dir '/work tree'",
		);
	});

	it("fails safe without an explicit per-engine permission policy", () => {
		assert.equal(workerLaunchPreflight({
			engine: "claude", permission: undefined, cwd: "/work", binary: "/bin/claude",
			cwdExists: true, binaryExists: true,
		}), "explicit permission policy is required for claude");
		assert.equal(workerLaunchPreflight({
			engine: "unknown", permission: "bypass", cwd: "/work", binary: "/bin/unknown",
			cwdExists: true, binaryExists: true,
		}), "unknown engine is not launchable");
	});
});

describe("launchWorkerSession", () => {
	function rig(options: { list?: string; failLaunch?: boolean; notes?: string[] } = {}) {
		const calls: string[][] = [];
		const notes = options.notes ?? [];
		const deleted: string[] = [];
		return {
			calls, notes, deleted,
			exec: async (args: string[]) => {
				calls.push(args);
				if (args[0] === "list-sessions") return options.list ?? "";
				if (args[0] === "new-session" && options.failLaunch) throw new Error("tmux failed");
				return "";
			},
			createNote: async (path: string) => { notes.push(path); },
			deleteNote: async (path: string) => { deleted.push(path); },
		};
	}

	it("creates a tagged tmux worker and note, then is idempotent", async () => {
		const first = rig();
		const result = await launchWorkerSession({
			project: "Demo", engine: "claude", sessionName: "Demo-1", cwd: "/work/tree",
			binary: "/bin/claude", permission: "bypass", maxConcurrent: 2,
			notePath: "01_Projects/Demo/sessions/Demo-1.md", noteContent: "engine: claude",
		}, { ...first, cwdExists: true, binaryExists: true });
		assert.equal(result.kind, "created");
		assert.ok(first.calls.some((a) => a[0] === "new-session" && a.includes("Demo-1")));
		assert.ok(first.calls.some((a) => a[0] === "send-keys" && a.includes("--dangerously-skip-permissions")));
		assert.deepEqual(first.notes, ["01_Projects/Demo/sessions/Demo-1.md"]);

		const duplicate = rig({ list: "Demo-1\t1\tDemo\tclaude\n" });
		const again = await launchWorkerSession({
			project: "Demo", engine: "claude", sessionName: "Demo-2", cwd: "/work/tree",
			binary: "/bin/claude", permission: "bypass", maxConcurrent: 2,
			notePath: "01_Projects/Demo/sessions/Demo-2.md", noteContent: "engine: claude",
		}, { ...duplicate, cwdExists: true, binaryExists: true });
		assert.deepEqual(again, { kind: "existing", sessionName: "Demo-1" });
		assert.equal(duplicate.notes.length, 0);
	});

	it("enforces capacity and rolls back a note when tmux launch fails", async () => {
		await assert.rejects(
			launchWorkerSession({
				project: "Demo", engine: "codex", sessionName: "Demo-2", cwd: "/work/tree",
				binary: "codex", permission: "bypass", maxConcurrent: 1,
				notePath: "Demo-2.md", noteContent: "engine: codex",
			}, { ...rig({ list: "Demo-1\t1\tDemo\tclaude\n" }), cwdExists: true, binaryExists: true }),
			/capacity limit/,
		);

		const failed = rig({ failLaunch: true });
		await assert.rejects(
			launchWorkerSession({
				project: "Demo", engine: "codex", sessionName: "Demo-1", cwd: "/work/tree",
				binary: "codex", permission: "bypass", maxConcurrent: 2,
				notePath: "Demo-1.md", noteContent: "engine: codex",
			}, { ...failed, cwdExists: true, binaryExists: true }),
			/tmux failed/,
		);
		assert.deepEqual(failed.notes, []);
		assert.deepEqual(failed.deleted, []);
	});
});

describe("worker tmux discovery", () => {
	it("parses only tagged workers and preserves engine/project metadata", () => {
		assert.deepEqual(parseWorkerSessions(
			"ordinary\t0\t\t\nworker-1\t1\tDemo\tcodex\nworker-2\t1\tDemo\tclaude\n",
		), [
			{ sessionName: "worker-1", project: "Demo", engine: "codex" },
			{ sessionName: "worker-2", project: "Demo", engine: "claude" },
		]);
	});
});
