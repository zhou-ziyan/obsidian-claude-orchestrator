import { readFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from "fs";
import { watch } from "fs";
import { join } from "path";
import { parseStopSignal, stopSignalDisposition, isStaleSignalFile, STOP_SIGNAL_DIR } from "./utils.ts";
import type { StopSignal, ProjectRegistry } from "./utils.ts";

export type StopSignalHandler = (signal: StopSignal, project: string) => void;
export interface StopSignalDiagnostic {
	reason: "vault-mismatch" | "invalid-signal" | "unclaimed-session" | "stale-signal" | "already-consumed";
	tmuxSession: string | null;
	provider: string | null;
	timestamp: number | null;
}
export type StopSignalDiagnosticHandler = (diagnostic: StopSignalDiagnostic) => void;

// Poll interval for the drain fallback. fs.watch on macOS sits on top of
// FSEvents and occasionally drops events under load — polling every few
// seconds catches anything the watcher missed without measurable cost on
// an empty directory.
const DRAIN_POLL_MS = 3000;

interface WatchHandle {
	close(): void;
}

export interface StopHookWatcherOptions {
	signalDir?: string;
	pollMs?: number;
	watch?: (path: string, listener: (eventType: string, filename: string | Buffer | null) => void) => WatchHandle;
}

export class StopHookWatcher {
	private watcher: WatchHandle | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private handlers: StopSignalHandler[] = [];
	private diagnosticHandlers: StopSignalDiagnosticHandler[] = [];
	private projects: () => ProjectRegistry;
	private vaultId: () => string;
	private signalDir: string;
	private pollMs: number;
	private watchDirectory: StopHookWatcherOptions["watch"];

	constructor(getProjects: () => ProjectRegistry, getVaultId: () => string, options: StopHookWatcherOptions = {}) {
		this.projects = getProjects;
		this.vaultId = getVaultId;
		this.signalDir = options.signalDir ?? STOP_SIGNAL_DIR;
		this.pollMs = options.pollMs ?? DRAIN_POLL_MS;
		this.watchDirectory = options.watch ?? ((path, listener) => watch(path, listener));
	}

	start(): void {
		if (this.watcher) return;
		try {
			mkdirSync(this.signalDir, { recursive: true });
		} catch {
			// dir may already exist
		}

		this.drainExisting();

		this.watcher = this.watchDirectory!(this.signalDir, (eventType, filename) => {
			const name = filename?.toString() ?? "";
			if (eventType === "rename" && name.endsWith(".json")) {
				this.processFile(join(this.signalDir, name));
			}
		});

		this.pollTimer = setInterval(() => this.drainExisting(), this.pollMs);
	}

	stop(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	onSignal(handler: StopSignalHandler): void {
		this.handlers.push(handler);
	}

	onDiagnostic(handler: StopSignalDiagnosticHandler): void {
		this.diagnosticHandlers.push(handler);
	}

	private drainExisting(): void {
		try {
			const files = readdirSync(this.signalDir);
			for (const f of files) {
				if (f.endsWith(".json")) {
					this.processFile(join(this.signalDir, f));
				}
			}
		} catch {
			// dir may not exist yet
		}
	}

	// The signal dir is shared by all vaults: never delete before knowing the
	// file is ours (or provably nobody's). Files ignored here belong to
	// another vault's plugin instance; if that instance is gone, the TTL
	// check reaps them.
	private processFile(filePath: string): void {
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			return;
		}

		const signal = parseStopSignal(content);
		const { action, project } = stopSignalDisposition(signal, this.vaultId(), this.projects());

		if (action === "ignore") {
			this.emitDiagnostic({
				reason: signal?.vault && signal.vault !== this.vaultId() ? "vault-mismatch" : "unclaimed-session",
				tmuxSession: signal?.tmuxSession ?? null,
				provider: signal?.provider ?? null,
				timestamp: signal?.timestamp ?? null,
			});
			try {
				if (isStaleSignalFile(statSync(filePath).mtimeMs, Date.now())) {
					unlinkSync(filePath);
					this.emitDiagnostic({
						reason: "stale-signal",
						tmuxSession: signal?.tmuxSession ?? null,
						provider: signal?.provider ?? null,
						timestamp: signal?.timestamp ?? null,
					});
				}
			} catch { /* already deleted */ }
			return;
		}

		try {
			unlinkSync(filePath);
		} catch {
			// already deleted — another consumer got here first; don't
			// double-dispatch.
			this.emitDiagnostic({
				reason: "already-consumed",
				tmuxSession: signal?.tmuxSession ?? null,
				provider: signal?.provider ?? null,
				timestamp: signal?.timestamp ?? null,
			});
			return;
		}

		if (action === "consume" && signal && project) {
			for (const handler of this.handlers) {
				handler(signal, project);
			}
		} else {
			this.emitDiagnostic({
				reason: signal ? "unclaimed-session" : "invalid-signal",
				tmuxSession: signal?.tmuxSession ?? null,
				provider: signal?.provider ?? null,
				timestamp: signal?.timestamp ?? null,
			});
		}
	}

	private emitDiagnostic(diagnostic: StopSignalDiagnostic): void {
		for (const handler of this.diagnosticHandlers) handler(diagnostic);
	}
}
