import { createDefaultSessionNote } from "./session-note.ts";
import { shellQuote } from "./worker-launch.ts";
import type { WorkerLaunchDeps, WorkerLaunchResult } from "./worker-launch.ts";

export interface TerminalLaunchRequest {
	project: string;
	sessionName: string;
	cwd: string;
	shell: string;
	notePath: string;
	vaultId: string;
}

/** A plain shell is a session mode, not an AI provider or a background worker. */
export async function launchTerminalSession(
	request: TerminalLaunchRequest,
	deps: WorkerLaunchDeps,
): Promise<WorkerLaunchResult> {
	if (!request.cwd.startsWith("/") || !deps.cwdExists) throw new Error("Terminal directory does not exist");
	if (!request.shell.startsWith("/") || !deps.binaryExists) throw new Error("Terminal shell is not available");
	// No -A: a concurrent name collision must fail without attaching to or
	// cleaning up another session. Only start rollback after our creation succeeds.
	await deps.exec([
		"new-session", "-d", "-s", request.sessionName, "-c", request.cwd,
		`${shellQuote(request.shell)} -l`,
		";", "set-option", "-t", request.sessionName, "@co_project", request.project,
		";", "set-option", "-t", request.sessionName, "@co_engine", "terminal",
		";", "set-option", "-t", request.sessionName, "@co_vault", request.vaultId,
	]);
	let noteCreated = false;
	try {
		await deps.createNote(request.notePath, createDefaultSessionNote(request.sessionName, "manual", "terminal"));
		noteCreated = true;
		await deps.exec(["has-session", "-t", request.sessionName]);
		return { kind: "created", sessionName: request.sessionName };
	} catch (error) {
		await deps.exec(["kill-session", "-t", request.sessionName]).catch(() => {});
		if (noteCreated) await deps.deleteNote?.(request.notePath).catch(() => {});
		throw error;
	}
}
