import { readFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { parseStopSignal, projectFromSessionName, STOP_SIGNAL_DIR } from "./utils";
import type { StopSignal, ProjectRegistry } from "./utils";

export type StopSignalHandler = (signal: StopSignal, project: string) => void;

export class StopHookWatcher {
	private watcher: FSWatcher | null = null;
	private handlers: StopSignalHandler[] = [];
	private projects: () => ProjectRegistry;

	constructor(getProjects: () => ProjectRegistry) {
		this.projects = getProjects;
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
	}

	stop(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
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

	private processFile(filePath: string): void {
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			return;
		}

		try {
			unlinkSync(filePath);
		} catch {
			// already deleted
		}

		const signal = parseStopSignal(content);
		if (!signal) return;

		const project = projectFromSessionName(signal.tmuxSession, this.projects());
		if (!project) return;

		for (const handler of this.handlers) {
			handler(signal, project);
		}
	}
}
