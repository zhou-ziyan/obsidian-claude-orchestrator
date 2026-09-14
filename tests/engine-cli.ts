/**
 * Command lines for driving the real CLIs from the end-to-end tests.
 *
 * This is test-only scaffolding, deliberately not part of the plugin. The
 * plugin never launches or resumes an agent CLI — a tmux session is a plain
 * login shell and the user starts `claude` or `codex` in it themselves — so
 * shipping a launch/resume API in `src/` would be an interface with no
 * caller. The escaping below is still load-bearing: these strings are typed
 * into an interactive shell, where an unquoted path containing a space would
 * silently run the wrong command.
 */

/** Quote a token for an interactive POSIX shell. */
export function shellQuote(token: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, "'\\''")}'`;
}

function line(command: string, args: string[]): string {
	return [command, ...args].map(shellQuote).join(" ");
}

function modelArgs(model: string | undefined, flag: string): string[] {
	const trimmed = model?.trim() ?? "";
	return trimmed ? [flag, trimmed] : [];
}

export function claudeLaunchLine(binary: string, model?: string): string {
	return line(binary, modelArgs(model, "--model"));
}

export function claudeResumeLine(binary: string, conversationId?: string | null, model?: string): string {
	const id = conversationId?.trim() ?? "";
	return line(binary, [...(id ? ["--resume", id] : ["--continue"]), ...modelArgs(model, "--model")]);
}

export function codexLaunchLine(binary: string, model?: string): string {
	return line(binary, modelArgs(model, "-m"));
}

/**
 * Codex resumes by its own session id. Measured in CodexProbe: the id is
 * unchanged across a resume, so it is a stable key — but `codex resume`
 * takes a narrower flag set than `codex exec`, hence nothing else here.
 */
export function codexResumeLine(binary: string, conversationId?: string | null, model?: string): string {
	const id = conversationId?.trim() ?? "";
	return line(binary, ["resume", ...(id ? [id] : ["--last"]), ...modelArgs(model, "-m")]);
}
