import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTmuxBinary } from "../src/tmux.ts";
import { launchWorkerSession } from "../src/worker-launch.ts";

const run = (binary: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
	execFile(binary, args, { encoding: "utf8" }, (error, stdout) => error ? reject(error instanceof Error ? error : new Error("command failed")) : resolve(stdout));
});

describe("e2e: isolated tmux worker launch", () => {
	it("creates a tagged session, injects the engine command, and cleans up", async () => {
		const tmux = findTmuxBinary();
		try { await run(tmux, ["-V"]); } catch { return; }
		const cwd = await mkdtemp(join(tmpdir(), "co-worker-e2e-"));
		const fakeCli = join(cwd, "worker-cli");
		await writeFile(fakeCli, "#!/bin/sh\nsleep 2\n");
		await chmod(fakeCli, 0o755);
		const session = `co-worker-e2e-${process.pid}-${Date.now()}`;
		const calls: string[][] = [];
		const exec = async (args: string[]) => {
			calls.push(args);
			return run(tmux, args);
		};
		try {
			const result = await launchWorkerSession({
				project: "E2E", engine: "claude", sessionName: session, cwd,
				binary: fakeCli, permission: "bypass", maxConcurrent: 1,
				notePath: join(cwd, "session.md"), noteContent: "engine: claude",
			}, {
				exec,
				cwdExists: true,
				binaryExists: true,
				createNote: async () => {},
			});
			assert.deepEqual(result, { kind: "created", sessionName: session });
			const metadata = await run(tmux, ["list-sessions", "-F", "#{session_name}\t#{@co_worker}\t#{@co_project}\t#{@co_engine}"]);
			assert.match(metadata, new RegExp(`${session}\\t1\\tE2E\\tclaude`));
			assert.ok(calls.some((args) => args[0] === "new-session" && args.join(" ").includes("--dangerously-skip-permissions")));
		} finally {
			await run(tmux, ["kill-session", "-t", session]).catch(() => {});
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
