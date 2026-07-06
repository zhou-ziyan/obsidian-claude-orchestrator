import { readFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from "fs";
import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { parseStopSignal, stopSignalDisposition, isStaleSignalFile, STOP_SIGNAL_DIR } from "./utils";
import type { StopSignal, ProjectRegistry } from "./utils";

export type StopSignalHandler = (signal: StopSignal, project: string) => void;

// Poll interval for the drain fallback. fs.watch on macOS sits on top of
// FSEvents and occasionally drops events under load — polling every few
// seconds catches anything the watcher missed without measurable cost on
// an empty directory.
const DRAIN_POLL_MS = 3000;

export class StopHookWatcher {
	private watcher: FSWatcher | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private handlers: StopSignalHandler[] = [];
	private projects: () => ProjectRegistry;
	private vaultId: () => string;

	constructor(getProjects: () => ProjectRegistry, getVaultId: () => string) {
		this.projects = getProjects;
		this.vaultId = getVaultId;
	}

	start(): void {
		if (this.watcher) return;
		try {
			mkdirSync(STOP_SIGNAL_DIR, { recursive: true });
		} catch {
			// dir may already exist
		}

		this.drainExisting();

		this.watcher = watch(STOP_SIGNAL_DIR, (eventType, filename) => {
			if (eventType === "rename" && filename?.endsWith(".json")) {
				this.processFile(join(STOP_SIGNAL_DIR, filename));
			}
		});

		this.pollTimer = setInterval(() => this.drainExisting(), DRAIN_POLL_MS);
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

	private drainExisting(): void {
		try {
			const files = readdirSync(STOP_SIGNAL_DIR);
			for (const f of files) {
				if (f.endsWith(".json")) {
					this.processFile(join(STOP_SIGNAL_DIR, f));
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
			try {
				if (isStaleSignalFile(statSync(filePath).mtimeMs, Date.now())) {
					unlinkSync(filePath);
				}
			} catch { /* already deleted */ }
			return;
		}

		try {
			unlinkSync(filePath);
		} catch {
			// already deleted — another consumer got here first; don't
			// double-dispatch.
			return;
		}

		if (action === "consume" && signal && project) {
			for (const handler of this.handlers) {
				handler(signal, project);
			}
		}
	}
}
