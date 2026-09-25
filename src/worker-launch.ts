/**
 * Safe, idempotent worker-session launch primitives.
 *
 * The caller supplies the already-resolved project worktree and permission
 * policy. This module never reads credentials, logs environment values, or
 * silently chooses an engine/policy. A tmux session is tagged so repeated
 * requests and Lighthouse's tmux discovery can find the same worker.
 */
import type { EngineId } from "./engines.ts";
import type { WorkerPermissionMode, WorkerPermissionSetting } from "./projects.ts";

export type WorkerLaunchKind = "worker" | "interactive";

export interface WorkerLaunchPreflightInput {
	engine: string;
	permission: WorkerPermissionMode | undefined;
	cwd: string;
	binary: string;
	cwdExists: boolean;
	binaryExists: boolean;
}

export interface WorkerLaunchRequest {
	project: string;
	engine: EngineId;
	sessionName: string;
	cwd: string;
	binary: string;
	permission: WorkerPermissionMode | undefined;
	maxConcurrent: number;
	notePath: string;
	noteContent: string;
	vaultId?: string;
	/** Worker mode is the legacy default; interactive mode is for an explicitly selected new session. */
	kind?: WorkerLaunchKind;
	/** Interactive sessions never reuse by project/engine, but attach still reuses their exact name. */
	reuseExisting?: boolean;
}

export interface WorkerSession {
	sessionName: string;
	project: string;
	engine: string;
}

export interface WorkerLaunchDeps {
	exec: (args: string[]) => Promise<string>;
	createNote: (path: string, content: string) => Promise<void>;
	deleteNote?: (path: string) => Promise<void>;
	cwdExists: boolean;
	binaryExists: boolean;
}

export interface WorkerLaunchResult {
	kind: "created" | "existing";
	sessionName: string;
}

/**
 * Clicking either launch action is explicit authorization to start the CLI.
 * Missing legacy settings therefore use the least-privileged prompt policy.
 * A persisted disabled value still blocks workers, but never blocks a normal
 * interactive session.
 */
export function resolveLaunchPermission(
	kind: WorkerLaunchKind,
	configured: WorkerPermissionSetting | undefined,
): WorkerPermissionMode | undefined {
	if (configured === "prompt" || configured === "bypass") return configured;
	if (configured === undefined || kind === "interactive") return "prompt";
	return undefined;
}

/** Quote one argument for the interactive POSIX shell inside tmux. */
export function shellQuote(token: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(token)
		? token
		: `'${token.replace(/'/g, "'\\''")}'`;
}

export function buildWorkerLaunchArgs(
	engine: EngineId,
	binary: string,
	permission: WorkerPermissionMode,
	cwd: string,
): string[] {
	if (engine === "claude") {
		return [
			binary,
			...(permission === "bypass" ? ["--dangerously-skip-permissions"] : []),
			"--add-dir", cwd,
		];
	}
	return [
		binary,
		...(permission === "bypass"
			? ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"]
			: ["-a", "on-request", "-s", "workspace-write"]),
		"-C", cwd,
	];
}

export function buildWorkerLaunchLine(
	engine: EngineId,
	binary: string,
	permission: WorkerPermissionMode,
	cwd: string,
): string {
	return buildWorkerLaunchArgs(engine, binary, permission, cwd).map(shellQuote).join(" ");
}

/** Return null when launch is allowed, otherwise a user-safe reason. */
export function workerLaunchPreflight(input: WorkerLaunchPreflightInput): string | null {
	if (input.engine !== "claude" && input.engine !== "codex") {
		return "unknown engine is not launchable";
	}
	if (input.permission !== "prompt" && input.permission !== "bypass") {
		return `explicit permission policy is required for ${input.engine}`;
	}
	if (!input.cwd.startsWith("/") || input.cwd === "/") return "worker target must be a non-root absolute directory";
	if (!input.cwdExists) return "worker target directory does not exist";
	if (!input.binaryExists) return `${input.engine} binary is not available`;
	return null;
}

/** Parse `tmux list-sessions -F` worker metadata without trusting ordinary sessions. */
export function parseWorkerSessions(output: string): WorkerSession[] {
	const sessions: WorkerSession[] = [];
	for (const line of output.split("\n")) {
		const [sessionName, worker, project, engine] = line.trim().split("\t");
		if (worker !== "1" || !sessionName || !project || !engine) continue;
		sessions.push({ sessionName, project, engine });
	}
	return sessions;
}

function allSessionNames(output: string): Set<string> {
	const names = new Set<string>();
	for (const line of output.split("\n")) {
		const name = line.trim().split("\t")[0];
		if (name) names.add(name);
	}
	return names;
}

function workerTmuxArgs(request: WorkerLaunchRequest): string[] {
	const isWorker = (request.kind ?? "worker") === "worker";
	return [
		"new-session", "-d", "-s", request.sessionName, "-c", request.cwd,
		buildWorkerLaunchLine(request.engine, request.binary, request.permission!, request.cwd),
		...(isWorker ? [";", "set-option", "-t", request.sessionName, "@co_worker", "1"] : []),
		";", "set-option", "-t", request.sessionName, "@co_project", request.project,
		";", "set-option", "-t", request.sessionName, "@co_engine", request.engine,
		...(request.vaultId ? [";", "set-option", "-t", request.sessionName, "@co_vault", request.vaultId] : []),
	];
}

function killArgs(sessionName: string): string[] {
	return ["kill-session", "-t", sessionName];
}

/**
 * Create or find one worker or explicitly selected interactive session. The
 * caller serializes requests per project/engine; this function also rechecks
 * tmux state immediately before creating anything, so an existing session is
 * never launched twice.
 */
export async function launchWorkerSession(
	request: WorkerLaunchRequest,
	deps: WorkerLaunchDeps,
): Promise<WorkerLaunchResult> {
	const listing = await deps.exec(["list-sessions", "-F", "#{session_name}\t#{@co_worker}\t#{@co_project}\t#{@co_engine}"]);
	const names = allSessionNames(listing);
	const kind = request.kind ?? "worker";
	const existingWorker = parseWorkerSessions(listing).find(
		(worker) => worker.project === request.project && worker.engine === request.engine,
	);
	if (kind === "worker" && (request.reuseExisting ?? true) && existingWorker) {
		return { kind: "existing", sessionName: existingWorker.sessionName };
	}
	if (names.has(request.sessionName)) return { kind: "existing", sessionName: request.sessionName };

	const preflight = workerLaunchPreflight({
		engine: request.engine,
		permission: request.permission,
		cwd: request.cwd,
		binary: request.binary,
		cwdExists: deps.cwdExists,
		binaryExists: deps.binaryExists,
	});
	if (preflight) throw new Error(preflight);
	if (kind === "worker" && request.maxConcurrent < 1) throw new Error("capacity limit disables worker launch");
	if (kind === "worker" && parseWorkerSessions(listing).length >= request.maxConcurrent) {
		throw new Error(`worker capacity limit reached (${request.maxConcurrent})`);
	}

	await deps.exec(workerTmuxArgs(request));
	let noteCreated = false;
	try {
		await deps.createNote(request.notePath, request.noteContent);
		noteCreated = true;
		// A direct pane command means an immediately missing binary/auth failure
		// closes the pane instead of falling back to an apparently healthy shell.
		await deps.exec(["has-session", "-t", request.sessionName]);
		return { kind: "created", sessionName: request.sessionName };
	} catch (error) {
		await deps.exec(killArgs(request.sessionName)).catch(() => {});
		if (noteCreated) await deps.deleteNote?.(request.notePath).catch(() => {});
		throw error;
	}
}
