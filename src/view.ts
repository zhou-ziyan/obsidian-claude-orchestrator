import { FileSystemAdapter, ItemView, TFolder, ViewStateResult, WorkspaceLeaf } from "obsidian";
import {
	PROJECTS_DIR,
	normalizeViewState,
	sessionNotePath,
	createDefaultSessionNote,
	parseSessionNote,
	serializeSessionNote,
	SessionNote,
} from "./utils";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { IPty } from "node-pty";
import * as os from "os";
import * as path from "path";

export const VIEW_TYPE_TERMINAL = "claude-orchestrator-terminal";

export interface TerminalViewState {
	project?: string;
	sessionName?: string;
}

/**
 * Obsidian's renderer-side require fails node-pty's internal relative loads
 * (`require("../prebuilds/darwin-arm64//pty.node")` from lib/utils.js returns
 * "Cannot find module"). The absolute-path require works. So we preload
 * node-pty's utils module and swap its loader to use absolute paths before
 * requiring node-pty itself.
 */
function loadNodePty(pluginDir: string): typeof import("node-pty") {
	const ptyRoot = path.join(pluginDir, "node_modules", "node-pty");
	const platformDir = `${process.platform}-${process.arch}`;
	const prebuildDir = path.join(ptyRoot, "prebuilds", platformDir);
	const nativeBinaryPath = path.join(prebuildDir, "pty.node");

	const utils = require(path.join(ptyRoot, "lib", "utils.js"));
	const nativeBinary = require(nativeBinaryPath);
	utils.loadNativeModule = (_name: string) => ({
		dir: prebuildDir,
		module: nativeBinary,
	});

	return require(path.join(ptyRoot, "lib", "index.js"));
}

export class TerminalView extends ItemView {
	private term: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ptyProcess: IPty | null = null;
	private ptyGen = 0;
	private resizeObserver: ResizeObserver | null = null;
	private pluginDir: string;
	private ptyModule: typeof import("node-pty") | null = null;
	private awaitingRestart = false;
	private project: string | null = null;
	private sessionName: string | null = null;
	private xtermReady = false;
	private stateSeenPreOpen = false;
	private host: HTMLElement | null = null;
	private onTerminalFocus?: (project: string) => void;
	private getSettings?: () => { queuePanel: boolean };
	private historyPanel: HTMLElement | null = null;
	private queuePanel: HTMLElement | null = null;
	private queueList: HTMLElement | null = null;
	private sessionNote: SessionNote | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		pluginDir: string,
		onTerminalFocus?: (project: string) => void,
		getSettings?: () => { queuePanel: boolean },
	) {
		super(leaf);
		this.pluginDir = pluginDir;
		this.onTerminalFocus = onTerminalFocus;
		this.getSettings = getSettings;
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return this.sessionName
			? `Claude Orchestrator: ${this.sessionName}`
			: "Claude Orchestrator";
	}

	getIcon(): string {
		return "terminal";
	}

	getState(): Record<string, unknown> {
		return {
			...super.getState(),
			project: this.project ?? undefined,
			sessionName: this.sessionName ?? undefined,
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const normalized = normalizeViewState(state);
		this.project = normalized.project;
		this.sessionName = normalized.sessionName;
		if (!this.xtermReady) {
			this.stateSeenPreOpen = true;
		}
		await super.setState(state, result);
		if (this.xtermReady && !this.ptyProcess) {
			this.spawnShell();
		}
	}

	getProject(): string | null {
		return this.project;
	}

	getSessionName(): string | null {
		return this.sessionName;
	}

	setProject(project: string | null, sessionName?: string): void {
		this.project = project;
		this.sessionName = sessionName ?? project;
		if (this.xtermReady) {
			this.spawnShell();
			if (this.getSettings?.().queuePanel) {
				this.loadSessionNote();
			}
		}
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.style.padding = "0";
		container.style.display = "flex";
		container.style.flexDirection = "column";
		container.style.overflow = "hidden";

		const queueEnabled = this.getSettings?.().queuePanel ?? false;

		// History panel is disabled until stop-hook integration (M3b stage 2)
		// can automatically mark items as completed.

		// --- Terminal host (middle, flex: 1) ---
		const host = container.createDiv({ cls: "claude-orchestrator-term-host" });
		host.style.width = "100%";
		host.style.flex = "1";
		host.style.minHeight = "0";
		host.style.overflow = "hidden";
		host.style.minWidth = "0";
		this.host = host;

		host.addEventListener("focusin", this.onHostFocusIn);
		host.addEventListener("focusout", this.onHostFocusOut);

		// --- Resize handle between terminal and queue ---
		if (queueEnabled) {
			const resizeHandle = container.createDiv({ cls: "co-resize-handle" });
			let startY = 0;
			let startHeight = 0;

			const onMouseMove = (e: MouseEvent) => {
				const delta = startY - e.clientY;
				const newHeight = Math.max(80, Math.min(400, startHeight + delta));
				if (this.queuePanel) {
					this.queuePanel.style.height = `${newHeight}px`;
				}
				// Refit terminal after resize
				this.fitAddon?.fit();
				if (this.term && this.ptyProcess) {
					try {
						this.ptyProcess.resize(this.term.cols, this.term.rows);
					} catch { /* ignore */ }
				}
			};

			const onMouseUp = () => {
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
			};

			resizeHandle.addEventListener("mousedown", (e) => {
				e.preventDefault();
				startY = e.clientY;
				startHeight = this.queuePanel?.offsetHeight ?? 150;
				document.body.style.cursor = "row-resize";
				document.body.style.userSelect = "none";
				document.addEventListener("mousemove", onMouseMove);
				document.addEventListener("mouseup", onMouseUp);
			});
		}

		// --- Queue panel (bottom) ---
		if (queueEnabled) {
			this.queuePanel = container.createDiv({ cls: "co-queue-panel" });
			const queueHeader = this.queuePanel.createDiv({ cls: "co-panel-header co-queue-header" });

			const queueTitle = queueHeader.createSpan();
			queueTitle.textContent = "Queue";

			const sendBtn = queueHeader.createEl("button", {
				cls: "co-send-btn",
				text: "Send next ▶",
			});
			sendBtn.addEventListener("click", () => this.sendNext());

			this.queueList = this.queuePanel.createDiv({ cls: "co-queue-list" });

			const addRow = this.queuePanel.createDiv({ cls: "co-queue-add" });
			const input = addRow.createEl("input", {
				type: "text",
				placeholder: "Add task...",
				cls: "co-queue-input",
			});
			const addBtn = addRow.createEl("button", {
				cls: "co-add-btn",
				text: "+",
			});
			const doAdd = () => {
				const text = input.value.trim();
				if (!text || !this.sessionNote) return;
				this.sessionNote.queue.push(text);
				input.value = "";
				this.renderQueue();
				this.saveSessionNote();
			};
			addBtn.addEventListener("click", doAdd);
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") doAdd();
			});
		}

		this.term = new Terminal({
			cursorBlink: true,
			fontFamily: "Menlo, Monaco, 'Courier New', monospace",
			fontSize: 13,
			lineHeight: 1.2,
			theme: {
				background: "#1e1e1e",
				foreground: "#d4d4d4",
			},
		});
		this.fitAddon = new FitAddon();
		this.term.loadAddon(this.fitAddon);
		this.term.open(host);
		this.fitAddon.fit();

		try {
			this.ptyModule = loadNodePty(this.pluginDir);
		} catch (err) {
			this.term.writeln("\x1b[31mFailed to load node-pty:\x1b[0m");
			this.term.writeln(String(err));
			return;
		}

		this.term.onData((data) => {
			if (this.awaitingRestart) {
				this.awaitingRestart = false;
				this.spawnShell();
				return;
			}
			this.ptyProcess?.write(data);
		});

		this.resizeObserver = new ResizeObserver(() => {
			// Skip transient near-zero sizes during layout animations —
			// fitting at these sizes squashes the terminal to a few cols
			// and the PTY stays narrow even after layout stabilizes.
			if (!this.host || this.host.clientWidth < 50) return;
			this.fitAddon?.fit();
			if (this.term && this.ptyProcess) {
				try {
					this.ptyProcess.resize(this.term.cols, this.term.rows);
				} catch {
					/* ignore resize errors */
				}
			}
		});
		this.resizeObserver.observe(host);

		this.xtermReady = true;

		// Only auto-spawn on the state-restore path (setState fired before
		// onOpen). For fresh-creation via activateView, setProject will be
		// called immediately after and drives the spawn.
		if (this.stateSeenPreOpen) {
			this.spawnShell();
			if (this.getSettings?.().queuePanel) {
				this.loadSessionNote();
			}
		}
	}

	private computeCwd(): string {
		if (this.project) {
			const adapter = this.app.vault.adapter;
			if (adapter instanceof FileSystemAdapter) {
				return path.join(adapter.getBasePath(), "01_Projects", this.project);
			}
		}
		return os.homedir();
	}

	private spawnShell() {
		if (!this.term || !this.ptyModule) return;

		// Kill any existing pty; the generation guard below ensures its
		// pending callbacks (onExit etc.) become no-ops.
		if (this.ptyProcess) {
			try {
				this.ptyProcess.kill();
			} catch {
				/* ignore */
			}
			this.ptyProcess = null;
		}
		this.awaitingRestart = false;
		this.term.clear();

		const myGen = ++this.ptyGen;

		const shell = process.env.SHELL || "/bin/zsh";
		const cwd = this.computeCwd();

		const prependPath = ["/opt/homebrew/bin", "/usr/local/bin"];
		const existingPath = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
		const pathEntries = existingPath.split(":");
		for (const p of prependPath) {
			if (!pathEntries.includes(p)) pathEntries.unshift(p);
		}
		const env: { [key: string]: string } = {
			...(process.env as { [key: string]: string }),
			LANG: process.env.LANG || "en_US.UTF-8",
			LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
			PATH: pathEntries.join(":"),
		};

		let file: string;
		let args: string[];
		if (this.sessionName) {
			file = "tmux";
			args = ["new-session", "-A", "-s", this.sessionName];
		} else {
			file = shell;
			args = [];
		}

		let newPty: IPty;
		try {
			newPty = this.ptyModule.spawn(file, args, {
				name: "xterm-256color",
				cols: this.term.cols,
				rows: this.term.rows,
				cwd,
				env,
			});
		} catch (err) {
			this.term.writeln("\x1b[31mFailed to spawn:\x1b[0m");
			this.term.writeln(String(err));
			if (this.sessionName) {
				this.term.writeln(`Tried: tmux new-session -A -s ${this.sessionName}`);
				this.term.writeln("Is tmux installed and in PATH?");
			}
			return;
		}

		this.ptyProcess = newPty;

		newPty.onData((data) => {
			if (this.ptyGen !== myGen) return;
			this.term?.write(data);
		});
		newPty.onExit(() => {
			if (this.ptyGen !== myGen) return;
			this.ptyProcess = null;
			this.term?.writeln("\r\n\x1b[2m[exited — press any key to restart]\x1b[0m");
			this.awaitingRestart = true;
		});
	}

	// --- Session note I/O ---

	private async ensureSessionNote(): Promise<void> {
		if (!this.project || !this.sessionName) return;
		const notePath = sessionNotePath(this.project, this.sessionName);
		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (!existing) {
			// Ensure sessions/ directory exists
			const dirPath = `${PROJECTS_DIR}/${this.project}/sessions`;
			if (!this.app.vault.getAbstractFileByPath(dirPath)) {
				await this.app.vault.createFolder(dirPath);
			}
			await this.app.vault.create(
				notePath,
				createDefaultSessionNote(this.sessionName),
			);
		}
	}

	private async loadSessionNote(): Promise<void> {
		if (!this.project || !this.sessionName) return;
		await this.ensureSessionNote();
		const notePath = sessionNotePath(this.project, this.sessionName);
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!file || !(file instanceof TFolder === false && "path" in file)) {
			this.sessionNote = parseSessionNote("", this.sessionName);
			return;
		}
		const content = await this.app.vault.read(file as any);
		this.sessionNote = parseSessionNote(content, this.sessionName);
		this.renderHistory();
		this.renderQueue();
	}

	private async saveSessionNote(): Promise<void> {
		if (!this.project || !this.sessionName || !this.sessionNote) return;
		const notePath = sessionNotePath(this.project, this.sessionName);
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (file && "path" in file) {
			await this.app.vault.modify(
				file as any,
				serializeSessionNote(this.sessionNote),
			);
		}
	}

	// --- Panel rendering ---

	private renderHistory(): void {
		const content = this.historyPanel?.querySelector(".co-history-content") as HTMLElement | null;
		if (!content || !this.sessionNote) return;
		content.empty();

		if (this.sessionNote.history.length === 0) {
			content.createDiv({ cls: "co-empty", text: "No history yet." });
			return;
		}

		// Show most recent items first, with a truncated preview
		const items = [...this.sessionNote.history].reverse();
		for (const item of items) {
			const row = content.createDiv({ cls: "co-history-item" });
			const icon = item.completed ? "✓" : "⟳";
			const cls = item.completed ? "co-completed" : "co-in-progress";
			row.createSpan({ cls: `co-history-icon ${cls}`, text: icon });
			row.createSpan({
				cls: "co-history-text",
				text: item.text.length > 80 ? item.text.slice(0, 80) + "…" : item.text,
			});
		}
	}

	private dragFromIdx: number | null = null;

	private renderQueue(): void {
		if (!this.queueList || !this.sessionNote) return;
		this.queueList.empty();

		if (this.sessionNote.queue.length === 0) {
			this.queueList.createDiv({ cls: "co-empty", text: "Queue empty." });
			return;
		}

		this.sessionNote.queue.forEach((text, idx) => {
			const row = this.queueList!.createDiv({ cls: "co-queue-item" });
			row.draggable = true;
			row.dataset.idx = String(idx);

			row.addEventListener("dragstart", (e) => {
				this.dragFromIdx = idx;
				row.classList.add("co-dragging");
				e.dataTransfer?.setData("text/plain", String(idx));
			});
			row.addEventListener("dragend", () => {
				row.classList.remove("co-dragging");
				this.dragFromIdx = null;
			});
			row.addEventListener("dragover", (e) => {
				e.preventDefault();
				row.classList.add("co-drag-over");
			});
			row.addEventListener("dragleave", () => {
				row.classList.remove("co-drag-over");
			});
			row.addEventListener("drop", (e) => {
				e.preventDefault();
				row.classList.remove("co-drag-over");
				if (this.dragFromIdx === null || !this.sessionNote) return;
				const from = this.dragFromIdx;
				const to = idx;
				if (from === to) return;
				const [item] = this.sessionNote.queue.splice(from, 1);
				this.sessionNote.queue.splice(to, 0, item);
				this.renderQueue();
				this.saveSessionNote();
			});

			const grip = row.createSpan({ cls: "co-drag-grip", text: "⠿" });

			row.createSpan({
				cls: "co-queue-text",
				text: `${idx + 1}. ${text}`,
			});

			const actions = row.createDiv({ cls: "co-queue-actions" });

			const editBtn = actions.createEl("button", {
				cls: "co-edit-btn",
				text: "✎",
			});
			editBtn.addEventListener("click", () => {
				// Replace row content with an inline editor
				row.empty();
				const input = row.createEl("input", {
					type: "text",
					cls: "co-queue-input co-queue-edit-input",
					value: text,
				});
				const saveBtn = row.createEl("button", {
					cls: "co-add-btn",
					text: "✓",
				});
				const cancel = () => {
					this.renderQueue();
				};
				const save = () => {
					const newText = input.value.trim();
					if (newText && this.sessionNote) {
						this.sessionNote.queue[idx] = newText;
						this.saveSessionNote();
					}
					this.renderQueue();
				};
				saveBtn.addEventListener("click", save);
				input.addEventListener("keydown", (e) => {
					if (e.key === "Enter") save();
					if (e.key === "Escape") cancel();
				});
				input.focus();
				input.select();
			});

			const removeBtn = actions.createEl("button", {
				cls: "co-remove-btn",
				text: "×",
			});
			removeBtn.addEventListener("click", () => {
				this.sessionNote?.queue.splice(idx, 1);
				this.renderQueue();
				this.saveSessionNote();
			});
		});
	}

	// --- Send next ---

	private async sendNext(): Promise<void> {
		if (!this.sessionNote || !this.sessionName) return;
		if (this.sessionNote.queue.length === 0) return;

		const task = this.sessionNote.queue.shift()!;

		this.renderQueue();
		await this.saveSessionNote();

		// Inject into tmux session via send-keys.
		// Send text first, then Enter after a short delay so the
		// receiving application (e.g. Claude Code) has time to
		// process the pasted text before the newline arrives.
		const prependPath = ["/opt/homebrew/bin", "/usr/local/bin"];
		const existingPath = process.env.PATH || "/usr/bin:/bin";
		const entries = existingPath.split(":");
		for (const p of prependPath) {
			if (!entries.includes(p)) entries.unshift(p);
		}
		const env = { ...process.env, PATH: entries.join(":") };

		const { execFile } = require("child_process");
		execFile(
			"tmux",
			["send-keys", "-t", this.sessionName, task],
			{ env },
			() => {
				setTimeout(() => {
					execFile(
						"tmux",
						["send-keys", "-t", this.sessionName, "Enter"],
						{ env },
						() => { /* fire and forget */ },
					);
				}, 150);
			},
		);
	}

	private onHostFocusIn = () => {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.host) {
				view.host.classList.toggle("is-dimmed", view !== this);
			}
		}
		if (this.project && this.onTerminalFocus) {
			this.onTerminalFocus(this.project);
		}
	};

	private onHostFocusOut = () => {
		requestAnimationFrame(() => {
			const active = document.activeElement;
			const anyTerminalFocused = this.app.workspace
				.getLeavesOfType(VIEW_TYPE_TERMINAL)
				.some((leaf) => {
					const view = leaf.view;
					return (
						view instanceof TerminalView &&
						view.host?.contains(active)
					);
				});
			if (!anyTerminalFocused) {
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
					const view = leaf.view;
					if (view instanceof TerminalView && view.host) {
						view.host.classList.remove("is-dimmed");
					}
				}
			}
		});
	};

	async onClose() {
		// Clear dimming on remaining terminals when this one closes
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view !== this && view.host) {
				view.host.classList.remove("is-dimmed");
			}
		}
		this.host?.removeEventListener("focusin", this.onHostFocusIn);
		this.host?.removeEventListener("focusout", this.onHostFocusOut);
		this.host = null;
		this.historyPanel = null;
		this.queuePanel = null;
		this.queueList = null;
		this.sessionNote = null;
		this.ptyGen++; // invalidate pending callbacks
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		try {
			this.ptyProcess?.kill();
		} catch {
			/* ignore */
		}
		this.ptyProcess = null;
		this.ptyModule = null;
		this.term?.dispose();
		this.term = null;
		this.fitAddon = null;
		this.xtermReady = false;
	}
}
