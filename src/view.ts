import { debounce, FileSystemAdapter, ItemView, Notice, setIcon, TFile, TFolder, ViewStateResult, WorkspaceLeaf } from "obsidian";
import {
	findTmuxBinary,
	normalizeViewState,
	sessionDirPath,
	sessionNotePath,
	createDefaultSessionNote,
	parseSessionNote,
	serializeSessionNote,
	nowStamp,
	copyHistoryItemToQueue,
	HISTORY_ITEM_MIN_HEIGHT,
	shouldAutoSendAfterEdit,
	computeDisplayText,
	SessionNote,
	QUICK_REPLY_KEYS,
	buildQuickReplyTmuxArgs,
	cancelCopyModeArgs,
	nextQueueMode,
	queueModeLabel,
	fetchPtyUsage,
	getPtyStatus,
	ptyStatusMessage,
	parseQueueItemSegments,
	autoSendAction,
	AUTO_SEND_COUNTDOWN_MS,
	execTmux,
	filterSlashCommands,
} from "./utils";
import type { ProjectRegistry, QueueMode, StopReason, SlashCommandEntry } from "./utils";
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

	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- node-pty internals are untyped
	const utils = require(path.join(ptyRoot, "lib", "utils.js"));
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- native binary is untyped
	const nativeBinary = require(nativeBinaryPath);
	/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- patching untyped node-pty internal */
	utils.loadNativeModule = (_name: string) => ({
		dir: prebuildDir,
		module: nativeBinary,
	});
	/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

	// eslint-disable-next-line @typescript-eslint/no-unsafe-return -- node-pty module is untyped at require level
	return require(path.join(ptyRoot, "lib", "index.js"));
}

const TS_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] /;

function extractTimestamp(text: string): { stamp: string | null; body: string } {
	const m = text.match(TS_RE);
	if (m && m[1]) {
		// Show only HH:MM, not the full date
		const timeOnly = m[1].split(" ")[1] ?? m[1];
		return { stamp: timeOnly, body: text.slice(m[0]?.length ?? 0) };
	}
	return { stamp: null, body: text };
}

export class TerminalView extends ItemView {
	private term: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ptyProcess: IPty | null = null;
	private ptyListeners: { dispose(): void }[] = [];
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
	private onTerminalFocus?: (project: string, sessionName: string) => void;
	private getSettings?: () => { simpleMode: boolean; projects: ProjectRegistry; quickReplyKeys: string[]; slashCommands: SlashCommandEntry[] };
	private historyPanel: HTMLElement | null = null;
	private queuePanel: HTMLElement | null = null;
	private queueList: HTMLElement | null = null;
	private sessionNote: SessionNote | null = null;
	private pinnedNote: string | null = null;
	private pinLabel: HTMLElement | null = null;
	private termFocusIndicator: HTMLElement | null = null;
	private modeBtn: HTMLElement | null = null;
	private sendBtn: HTMLElement | null = null;
	private countdownTimer: ReturnType<typeof setInterval> | null = null;
	private countdownRemaining = 0;
	private escHandler: ((e: KeyboardEvent) => void) | null = null;
	private claudeIdle = false;
	private loadedAt = 0;
	private themeObserver: MutationObserver | null = null;

	private fitAndResize(): void {
		if (!this.host || this.host.clientWidth < 50) return;
		this.fitAddon?.fit();
		if (this.term && this.ptyProcess) {
			try { this.ptyProcess.resize(this.term.cols, this.term.rows); } catch { /* ignore */ }
		}
		if (this.sessionName) {
			this.refreshTmuxClient();
		}
	}

	private refreshTmuxClient(): void {
		void execTmux(["refresh-client", "-t", this.sessionName!]).catch(() => {});
	}

	private debouncedFit = debounce(() => this.fitAndResize(), 150, true);

	constructor(
		leaf: WorkspaceLeaf,
		pluginDir: string,
		onTerminalFocus?: (project: string, sessionName: string) => void,
		getSettings?: () => { simpleMode: boolean; projects: ProjectRegistry; quickReplyKeys: string[]; slashCommands: SlashCommandEntry[] },
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
		const dn = this.sessionNote?.displayName;
		if (dn) return dn;
		return computeDisplayText(this.project, this.sessionName);
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
			void this.spawnShell();
		}
	}

	getProject(): string | null {
		return this.project;
	}

	getSessionName(): string | null {
		return this.sessionName;
	}

	getPinnedNote(): string | null {
		return this.pinnedNote;
	}

	focusTerminal(): void {
		// If queue panel is active, focus the input box instead of terminal.
		const queueInput = this.queuePanel?.querySelector(".co-queue-input:not(.co-queue-edit-input)") as HTMLElement | null;
		if (queueInput) {
			queueInput.focus();
		} else {
			this.term?.focus();
		}
	}

	setProject(project: string | null, sessionName?: string): void {
		this.project = project;
		this.sessionName = sessionName ?? project;
		/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian internal API for tab title refresh */
		(this.leaf as any).updateHeader?.();
		/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
		if (this.xtermReady) {
			void this.spawnShell();
			void this.loadSessionNote();
		}
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.style.padding = "0";
		container.style.display = "flex";
		container.style.flexDirection = "column";
		container.style.overflow = "hidden";

		this.registerSessionNoteEvents();

		const queueEnabled = !(this.getSettings?.().simpleMode ?? false);

		if (queueEnabled) {
			this.createHistoryPanel(container);
		}

		this.createTerminalHost(container);

		if (queueEnabled) {
			this.createQueuePanel(container);
		}

		this.initializeTerminal();
	}

	private registerSessionNoteEvents(): void {
		const isMySessionNote = (filePath: string): boolean => {
			if (!this.sessionName) return false;
			const folder = this.vaultFolder();
			if (folder === null) return false;
			return filePath === sessionNotePath(folder, this.sessionName);
		};

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (this.savingSessionNote) return;
				if (!this.sessionNoteLoaded) return;
				if (isMySessionNote(file.path)) {
					void this.loadSessionNote();
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (isMySessionNote(file.path)) {
					void this.loadSessionNote();
				}
			}),
		);
	}

	private createHistoryPanel(container: HTMLElement): void {
		this.historyPanel = container.createDiv({ cls: "co-history-panel" });
		const header = this.historyPanel.createDiv({ cls: "co-panel-header" });
		const arrow = header.createSpan({ cls: "co-panel-arrow", text: "▾" });
		header.createSpan({ text: " History" });
		header.addEventListener("click", () => {
			const content = this.historyPanel?.querySelector(".co-history-content") as HTMLElement | null;
			if (content) {
				const collapsed = content.style.display === "none";
				content.style.display = collapsed ? "block" : "none";
				arrow.textContent = collapsed ? "▾" : "▸";
				if (collapsed) {
					requestAnimationFrame(() => {
						content.scrollTop = content.scrollHeight;
					});
				}
			}
		});
		this.historyPanel.createDiv({ cls: "co-history-content" });

		// Resize handle between history and terminal
		const historyResize = container.createDiv({ cls: "co-resize-handle" });
		let startY = 0;
		let startHeight = 0;

		const onMouseMove = (e: MouseEvent) => {
			const delta = e.clientY - startY;
			const newHeight = Math.max(HISTORY_ITEM_MIN_HEIGHT, Math.min(300, startHeight + delta));
			const content = this.historyPanel?.querySelector(".co-history-content") as HTMLElement | null;
			if (content) {
				content.style.maxHeight = `${newHeight}px`;
			}
			this.debouncedFit();
		};

		const onMouseUp = () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			this.fitAndResize();
		};

		historyResize.addEventListener("mousedown", (e) => {
			e.preventDefault();
			startY = e.clientY;
			const content = this.historyPanel?.querySelector(".co-history-content") as HTMLElement | null;
			startHeight = content?.offsetHeight ?? 120;
			document.body.style.cursor = "row-resize";
			document.body.style.userSelect = "none";
			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		});
	}

	private createTerminalHost(container: HTMLElement): void {
		const host = container.createDiv({ cls: "claude-orchestrator-term-host" });
		host.style.width = "100%";
		host.style.flex = "1";
		host.style.minHeight = "0";
		host.style.overflow = "hidden";
		host.style.minWidth = "0";
		this.host = host;

		host.addEventListener("focusin", this.onHostFocusIn);
		host.addEventListener("focusout", this.onHostFocusOut);
	}

	private createQueuePanel(container: HTMLElement): void {
		// Resize handle between terminal and queue
		const resizeHandle = container.createDiv({ cls: "co-resize-handle" });
		let startY = 0;
		let startHeight = 0;

		const onMouseMove = (e: MouseEvent) => {
			const delta = startY - e.clientY;
			const newHeight = Math.max(80, Math.min(400, startHeight + delta));
			if (this.queuePanel) {
				this.queuePanel.style.height = `${newHeight}px`;
			}
			this.debouncedFit();
		};

		const onMouseUp = () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			this.fitAndResize();
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

		// Queue panel
		this.queuePanel = container.createDiv({ cls: "co-queue-panel" });
		const queueHeader = this.queuePanel.createDiv({ cls: "co-panel-header co-queue-header" });

		const queueTitle = queueHeader.createSpan();
		queueTitle.textContent = "Queue";

		const headerRight = queueHeader.createDiv({ cls: "co-queue-header-right" });

		this.termFocusIndicator = headerRight.createSpan({ cls: "co-term-indicator", text: "▴" });
		this.termFocusIndicator.style.display = "none";

		// Pin note
		const pinGroup = headerRight.createDiv({ cls: "co-pin-group" });
		const pinBtn = pinGroup.createEl("button", {
			cls: "co-icon-btn",
			text: "📌",
		});
		this.pinLabel = pinGroup.createSpan({ cls: "co-pin-label" });
		this.pinLabel.textContent = "No note pinned";

		pinBtn.addEventListener("click", () => {
			let filePath: string | null = null;
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				if (leaf.getRoot() === this.app.workspace.rootSplit) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Obsidian MarkdownView.file not in public typings
					const file = (leaf.view as any)?.file as { path: string } | undefined;
					filePath = file?.path ?? null;
					break;
				}
			}
			if (filePath) {
				this.pinnedNote = filePath;
				this.updatePinLabel();
				void this.saveSessionNote();
			}
		});
		this.pinLabel.addEventListener("click", () => {
			if (this.pinnedNote) {
				this.pinnedNote = null;
				this.updatePinLabel();
				void this.saveSessionNote();
			}
		});

		this.modeBtn = headerRight.createEl("button", {
			cls: "co-text-btn co-mode-btn",
			text: queueModeLabel(this.sessionNote?.queueMode ?? "manual"),
		});
		this.modeBtn.title = "Click to cycle queue mode";
		this.modeBtn.addEventListener("click", () => {
			if (!this.sessionNote) return;
			this.sessionNote.queueMode = nextQueueMode(this.sessionNote.queueMode);
			this.cancelCountdown();
			this.updateModeBtn();
			void this.saveSessionNote();
			this.checkAutoSend();
		});

		const quickReplyGroup = headerRight.createDiv({ cls: "co-quick-reply-group" });
		const keys = this.getSettings?.().quickReplyKeys ?? [...QUICK_REPLY_KEYS];
		for (const key of keys) {
			const btn = quickReplyGroup.createEl("button", {
				cls: "co-text-btn co-quick-reply-btn",
				text: key,
			});
			btn.addEventListener("click", () => { void this.sendQuickReply(key); });
		}

		this.sendBtn = headerRight.createEl("button", {
			cls: "co-text-btn",
			text: "Send next ▶",
		});
		this.sendBtn.addEventListener("click", () => {
			if (this.countdownTimer) {
				this.cancelCountdown();
			} else {
				void this.sendNext();
			}
		});

		this.queueList = this.queuePanel.createDiv({ cls: "co-queue-list" });

		const addRow = this.queuePanel.createDiv({ cls: "co-queue-add" });
		const input = addRow.createEl("textarea", {
			placeholder: "Add task...",
			cls: "co-queue-input",
		});
		input.rows = 1;
		const autoResize = () => {
			input.style.height = "auto";
			input.style.height = `${input.scrollHeight}px`;
		};
		input.addEventListener("input", autoResize);
		input.addEventListener("paste", (e) => {
			const files = e.clipboardData?.files;
			if (files && files.length > 0) {
				const imageFile = Array.from(files).find((f) => f.type.startsWith("image/"));
				if (imageFile) {
					e.preventDefault();
					void (async () => {
						const buf = await imageFile.arrayBuffer();
						const ext = imageFile.type.split("/")[1] ?? "png";
						const name = `paste-${Date.now()}.${ext}`;
						const folder = (this.app.vault as unknown as { getConfig(k: string): string }).getConfig("attachmentFolderPath") || "";
						const destPath = folder ? `${folder}/${name}` : name;
						await this.app.vault.createBinary(destPath, buf);
						const pos = input.selectionStart ?? input.value.length;
						const ref = `![[${name}]]`;
						input.value = input.value.slice(0, pos) + ref + input.value.slice(pos);
						requestAnimationFrame(autoResize);
					})();
					return;
				}
			}
			requestAnimationFrame(autoResize);
		});

		let acDropdown: HTMLElement | null = null;
		let acItems: SlashCommandEntry[] = [];
		let acSelected = 0;

		const closeAc = () => {
			acDropdown?.remove();
			acDropdown = null;
			acItems = [];
			acSelected = 0;
		};

		const renderAc = () => {
			if (!acDropdown) return;
			acDropdown.empty();
			acItems.forEach((entry, i) => {
				const item = acDropdown!.createDiv({
					cls: `co-ac-item${i === acSelected ? " co-ac-selected" : ""}`,
				});
				item.createSpan({ cls: "co-ac-cmd", text: entry.command });
				if (entry.description) {
					item.createSpan({ cls: "co-ac-desc", text: entry.description });
				}
				item.addEventListener("mousedown", (e) => {
					e.preventDefault();
					input.value = entry.command + " ";
					closeAc();
					requestAnimationFrame(autoResize);
				});
			});
		};

		const updateAc = () => {
			const text = input.value;
			if (!text.startsWith("/") || text.includes(" ")) {
				closeAc();
				return;
			}
			const cmds = this.getSettings?.().slashCommands;
			const matches = filterSlashCommands(text, cmds);
			if (matches.length === 0) {
				closeAc();
				return;
			}
			acItems = matches;
			acSelected = 0;
			if (!acDropdown) {
				acDropdown = addRow.createDiv({ cls: "co-ac-dropdown" });
			}
			renderAc();
		};

		input.addEventListener("input", updateAc);

		const addBtn = addRow.createEl("button", {
			cls: "co-icon-btn",
			text: "+",
		});
		const doAdd = () => {
			closeAc();
			const text = input.value.trim();
			if (!text) {
				if (this.sessionNote && this.sessionNote.queue.length > 0) {
					void this.sendNext();
				}
				return;
			}
			if (!this.sessionNote) return;
			this.sessionNote.queue.push(`[${nowStamp()}] ${text}`);
			input.value = "";
			input.style.height = "auto";
			this.renderQueue();
			void this.saveSessionNote();
			this.checkAutoSend();
		};
		let composing = false;
		input.addEventListener("compositionstart", () => { composing = true; });
		input.addEventListener("compositionend", () => { composing = false; });
		addBtn.addEventListener("click", doAdd);
		input.addEventListener("keydown", (e) => {
			if (acDropdown && acItems.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					acSelected = (acSelected + 1) % acItems.length;
					renderAc();
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					acSelected = (acSelected - 1 + acItems.length) % acItems.length;
					renderAc();
					return;
				}
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					input.value = acItems[acSelected]!.command + " ";
					closeAc();
					requestAnimationFrame(autoResize);
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					closeAc();
					return;
				}
			}
			if (e.key === "Enter" && !e.shiftKey && !composing && !e.isComposing) { e.preventDefault(); doAdd(); }
		});
		input.addEventListener("blur", () => { setTimeout(closeAc, 150); });
	}

	private initializeTerminal(): void {
		if (!this.host) return;

		const isDark = document.body.classList.contains("theme-dark");
		this.term = new Terminal({
			cursorBlink: true,
			fontFamily: "Menlo, Monaco, 'Courier New', monospace",
			fontSize: 13,
			lineHeight: 1.2,
			theme: isDark
				? { background: "#1e1e1e", foreground: "#d4d4d4" }
				: { background: "#f5f5f5", foreground: "#383a42", cursor: "#383a42" },
		});
		this.fitAddon = new FitAddon();
		this.term.loadAddon(this.fitAddon);
		this.term.open(this.host);
		requestAnimationFrame(() => this.fitAddon?.fit());

		this.themeObserver = new MutationObserver(() => {
			const dark = document.body.classList.contains("theme-dark");
			this.term!.options.theme = dark
				? { background: "#1e1e1e", foreground: "#d4d4d4" }
				: { background: "#f5f5f5", foreground: "#383a42", cursor: "#383a42" };
		});
		this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

		this.term.textarea?.addEventListener("focus", () => {
			if (this.termFocusIndicator) this.termFocusIndicator.style.display = "";
		});
		this.term.textarea?.addEventListener("blur", () => {
			if (this.termFocusIndicator) this.termFocusIndicator.style.display = "none";
		});

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
				void this.spawnShell();
				return;
			}
			this.ptyProcess?.write(data);
		});

		this.resizeObserver = new ResizeObserver(() => this.debouncedFit());
		this.resizeObserver.observe(this.host);

		this.xtermReady = true;

		if (this.stateSeenPreOpen) {
			void this.spawnShell();
			void this.loadSessionNote();
		}
	}

	private computeCwd(): string {
		if (this.project) {
			const config = this.getSettings?.().projects[this.project];
			if (config?.workingDirectory) {
				return config.workingDirectory;
			}
			const adapter = this.app.vault.adapter;
			if (adapter instanceof FileSystemAdapter && config) {
				return config.vaultFolder
					? path.join(adapter.getBasePath(), config.vaultFolder)
					: adapter.getBasePath();
			}
		}
		return os.homedir();
	}

	private disposePty(): void {
		for (const d of this.ptyListeners) {
			try { d.dispose(); } catch { /* ignore */ }
		}
		this.ptyListeners = [];
		if (this.ptyProcess) {
			try { this.ptyProcess.kill(); } catch { /* ignore */ }
			this.ptyProcess = null;
		}
	}

	private async spawnShell() {
		if (!this.term || !this.ptyModule) return;

		this.disposePty();
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
			file = findTmuxBinary();
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
			const usage = await fetchPtyUsage();
			const ptyStatus = getPtyStatus(usage);
			if (ptyStatus === "exhausted" || ptyStatus === "warning") {
				this.term.writeln(`\x1b[33m${ptyStatusMessage(usage, ptyStatus)}\x1b[0m`);
			} else if (this.sessionName) {
				this.term.writeln(`Tried: tmux new-session -A -s ${this.sessionName}`);
				this.term.writeln("Is tmux installed and in PATH?");
			}
			return;
		}

		this.ptyProcess = newPty;

		this.ptyListeners = [
			newPty.onData((data) => {
				if (this.ptyGen !== myGen) return;
				this.term?.write(data);
			}),
			newPty.onExit(() => {
				if (this.ptyGen !== myGen) return;
				this.ptyProcess = null;
				this.term?.writeln("\r\n\x1b[2m[exited — press any key to restart]\x1b[0m");
				this.awaitingRestart = true;
			}),
		];
	}

	// --- Session note I/O ---

	private vaultFolder(): string | null {
		if (!this.project) return null;
		const config = this.getSettings?.().projects[this.project];
		if (!config) return null;
		return config.vaultFolder;
	}

	private async ensureSessionNote(): Promise<void> {
		if (!this.project || !this.sessionName) return;
		const folder = this.vaultFolder();
		if (folder === null) return;
		const notePath = sessionNotePath(folder, this.sessionName);
		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (!existing) {
			const dirPath = sessionDirPath(folder);
			if (!this.app.vault.getAbstractFileByPath(dirPath)) {
				await this.app.vault.createFolder(dirPath);
			}
			await this.app.vault.create(
				notePath,
				createDefaultSessionNote(this.sessionName),
			);
		}
	}

	private sessionNoteLoaded = false;
	private savingSessionNote = false;

	private async loadSessionNote(): Promise<void> {
		if (!this.project || !this.sessionName) return;
		this.sessionNoteLoaded = false;
		await this.ensureSessionNote();
		const folder = this.vaultFolder();
		if (folder === null) return;
		const notePath = sessionNotePath(folder, this.sessionName);
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!file || file instanceof TFolder) {
			this.sessionNote = parseSessionNote("", this.sessionName);
			this.sessionNoteLoaded = true;
			return;
		}
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);
		this.sessionNote = parseSessionNote(content, this.sessionName);
		this.pinnedNote = this.sessionNote.pinnedNote;
		this.claudeIdle = false;
		this.loadedAt = Date.now();
		this.sessionNoteLoaded = true;
		this.renderHistory();
		this.renderQueue();
		this.updatePinLabel();
		this.updateModeBtn();
		/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian internal API */
		(this.leaf as any).updateHeader?.();
		/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
		this.checkAutoSend();
	}

	private async saveSessionNote(): Promise<void> {
		if (!this.project || !this.sessionName || !this.sessionNote) return;
		this.sessionNote.pinnedNote = this.pinnedNote;
		const folder = this.vaultFolder();
		if (folder === null) return;
		const notePath = sessionNotePath(folder, this.sessionName);
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (file instanceof TFile) {
			this.savingSessionNote = true;
			await this.app.vault.modify(
				file,
				serializeSessionNote(this.sessionNote),
			);
			this.savingSessionNote = false;
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

		// Show oldest first (top) → newest last (bottom)
		for (const item of this.sessionNote.history) {
			const row = content.createDiv({ cls: "co-history-item" });
			const icon = item.completed ? "✓" : "⟳";
			const cls = item.completed ? "co-completed" : "co-in-progress";
			row.createSpan({ cls: `co-history-icon ${cls}`, text: icon });
			const { stamp, body } = extractTimestamp(item.text);
			if (stamp) {
				row.createSpan({ cls: "co-timestamp", text: stamp });
			}
			const textSpan = row.createSpan({
				cls: "co-history-text co-collapsed",
				text: body,
			});
			textSpan.addEventListener("click", () => {
				textSpan.classList.toggle("co-collapsed");
			});

			// Copy-to-queue button
			const copyBtn = row.createEl("button", {
				cls: "co-icon-btn co-history-copy-btn",
			});
			setIcon(copyBtn, "copy");
			copyBtn.title = "Copy to queue";
			copyBtn.addEventListener("click", () => {
				if (!this.sessionNote) return;
				copyHistoryItemToQueue(item.text, this.sessionNote.queue);
				this.renderQueue();
				void this.saveSessionNote();
			});
		}

		// Scroll to bottom to show the most recent item
		content.scrollTop = content.scrollHeight;
	}

	private updatePinLabel(): void {
		if (!this.pinLabel) return;
		if (this.pinnedNote) {
			// Show just the filename without path
			const name = this.pinnedNote.split("/").pop()?.replace(/\.md$/, "") ?? this.pinnedNote;
			this.pinLabel.textContent = name;
			this.pinLabel.classList.add("co-pin-active");
		} else {
			this.pinLabel.textContent = "No note pinned";
			this.pinLabel.classList.remove("co-pin-active");
		}
	}

	private updateModeBtn(): void {
		if (!this.modeBtn) return;
		const mode: QueueMode = this.sessionNote?.queueMode ?? "manual";
		this.modeBtn.textContent = queueModeLabel(mode);
		this.modeBtn.dataset.mode = mode;
	}

	private renderQueue(): void {
		if (!this.queueList || !this.sessionNote) return;
		this.queueList.empty();

		if (this.sendBtn) {
			this.sendBtn.toggleClass("co-accent", this.sessionNote.queue.length > 0);
		}

		if (this.sessionNote.queue.length === 0) {
			this.queueList.createDiv({ cls: "co-empty", text: "Queue empty." });
			return;
		}

		this.sessionNote.queue.forEach((text, idx) => {
			this.renderQueueItem(this.queueList!, text, idx);
		});
	}

	private renderQueueItem(parent: HTMLElement, text: string, idx: number): void {
		const row = parent.createDiv({ cls: "co-queue-item" });
		row.dataset.idx = String(idx);

		const { stamp, body } = extractTimestamp(text);
		if (stamp) {
			row.createSpan({ cls: "co-timestamp", text: stamp });
		}
		const textSpan = row.createSpan({ cls: "co-queue-text co-collapsed" });
		const segments = parseQueueItemSegments(body);
		if (segments.some((s) => s.type === "image")) {
			textSpan.createSpan({ text: `${idx + 1}. ` });
			for (const seg of segments) {
				if (seg.type === "text") {
					textSpan.createSpan({ text: seg.content });
				} else {
					const img = textSpan.createEl("img", { cls: "co-queue-img" });
					img.alt = seg.content.split("/").pop() ?? seg.content;
					const file = this.app.metadataCache.getFirstLinkpathDest(seg.content, "");
					if (file) {
						img.src = this.app.vault.getResourcePath(file);
					} else {
						img.src = seg.content;
					}
				}
			}
		} else {
			textSpan.textContent = `${idx + 1}. ${body}`;
		}
		textSpan.addEventListener("click", () => {
			textSpan.classList.toggle("co-collapsed");
		});

		const actions = row.createDiv({ cls: "co-queue-actions" });

		if (idx > 0) {
			const upBtn = actions.createEl("button", {
				cls: "co-icon-btn co-move-btn",
				text: "▴",
			});
			upBtn.addEventListener("click", () => {
				if (!this.sessionNote) return;
				const [item] = this.sessionNote.queue.splice(idx, 1);
				if (item !== undefined) this.sessionNote.queue.splice(idx - 1, 0, item);
				this.renderQueue();
				void this.saveSessionNote();
			});
		} else {
			actions.createSpan({ cls: "co-btn-spacer" });
		}
		if (this.sessionNote && idx < this.sessionNote.queue.length - 1) {
			const downBtn = actions.createEl("button", {
				cls: "co-icon-btn co-move-btn",
				text: "▾",
			});
			downBtn.addEventListener("click", () => {
				if (!this.sessionNote) return;
				const [item] = this.sessionNote.queue.splice(idx, 1);
				if (item !== undefined) this.sessionNote.queue.splice(idx + 1, 0, item);
				this.renderQueue();
				void this.saveSessionNote();
			});
		} else {
			actions.createSpan({ cls: "co-btn-spacer" });
		}

		const editBtn = actions.createEl("button", {
			cls: "co-icon-btn co-success",
			text: "✎",
		});
		editBtn.addEventListener("click", () => {
			row.empty();
			const tsMatch = text.match(/^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] )/);
			const tsPrefix = tsMatch?.[1] ?? "";
			const editableText = tsPrefix ? text.slice(tsPrefix.length) : text;

			const input = row.createEl("textarea", {
				cls: "co-queue-input co-queue-edit-input",
			});
			input.value = editableText;
			input.rows = 1;
			const autoResize = () => {
				input.style.height = "auto";
				input.style.height = `${input.scrollHeight}px`;
			};
			input.addEventListener("input", autoResize);
			input.addEventListener("paste", () => {
				requestAnimationFrame(autoResize);
			});

			const saveBtn = row.createEl("button", {
				cls: "co-icon-btn co-success",
				text: "✓",
			});
			const cancel = () => {
				this.renderQueue();
			};
			const save = () => {
				const newText = input.value.trim();
				if (newText && this.sessionNote) {
					this.sessionNote.queue[idx] = `${tsPrefix}${newText}`;
					void this.saveSessionNote();
					if (shouldAutoSendAfterEdit(this.sessionNote.queue.length)) {
						void this.sendNext();
						return;
					}
				}
				this.renderQueue();
			};
			let editComposing = false;
			input.addEventListener("compositionstart", () => { editComposing = true; });
			input.addEventListener("compositionend", () => { editComposing = false; });
			saveBtn.addEventListener("click", save);
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.shiftKey && !editComposing && !e.isComposing) { e.preventDefault(); save(); }
				if (e.key === "Escape") cancel();
			});
			input.focus();
			input.select();
			requestAnimationFrame(autoResize);
		});

		const removeBtn = actions.createEl("button", {
			cls: "co-icon-btn co-danger",
			text: "×",
		});
		removeBtn.addEventListener("click", () => {
			this.sessionNote?.queue.splice(idx, 1);
			this.renderQueue();
			void this.saveSessionNote();
		});
	}

	// --- Send next ---

	async sendNext(): Promise<void> {
		if (!this.sessionNote || !this.sessionName) return;
		if (this.sessionNote.queue.length === 0) return;

		this.cancelCountdown();
		this.claudeIdle = false;
		this.sessionNote.status = "running";
		const task = this.sessionNote.queue.shift()!;

		// Move to history as in-progress
		this.sessionNote.history.push({ text: task, completed: false });
		this.renderHistory();
		this.renderQueue();
		await this.saveSessionNote();

		// Strip timestamp prefix before injecting (e.g. "[2026-04-15 23:15] actual text")
		const taskText = task.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /, "");

		const target = this.sessionName;

		void (async () => {
			await execTmux(cancelCopyModeArgs(target)).catch(() => {});
			try {
				await execTmux(["send-keys", "-l", "-t", target, taskText]);
				await new Promise((r) => setTimeout(r, 150));
				await execTmux(["send-keys", "-t", target, "Enter"]);
			} catch (err) {
				new Notice(`Send failed: ${(err as Error).message}`);
			}
		})();
	}

	private async sendQuickReply(key: string): Promise<void> {
		if (!this.sessionName) return;

		if (this.sessionNote) {
			this.sessionNote.status = "running";
			this.claudeIdle = false;
			void this.saveSessionNote();
		}

		const { textArgs, enterArgs } = buildQuickReplyTmuxArgs(this.sessionName, key);

		await execTmux(cancelCopyModeArgs(this.sessionName)).catch(() => {});
		try {
			await execTmux(textArgs);
			await new Promise((r) => setTimeout(r, 150));
			await execTmux(enterArgs);
		} catch (err) {
			new Notice(`Quick reply failed: ${(err as Error).message}`);
		}
	}

	onStopSignal(stopReason: StopReason | null): void {
		if (!this.sessionNote) return;

		this.claudeIdle = stopReason !== "asking";
		this.sessionNote.status = stopReason === "asking" ? "waiting_for_user" : "idle";

		if (stopReason === "done") {
			const last = this.sessionNote.history[this.sessionNote.history.length - 1];
			if (last && !last.completed) {
				last.completed = true;
			}
		}

		this.renderHistory();
		void this.saveSessionNote();

		const action = autoSendAction(
			this.sessionNote.queueMode,
			stopReason,
			this.sessionNote.queue.length,
		);

		if (action === "send") {
			this.startCountdown();
		} else if (action === "notify") {
			this.notifyUser(`Claude finished — ${this.sessionNote.queue.length} item(s) in queue`);
		}
	}

	private startCountdown(): void {
		this.cancelCountdown();
		if (!this.sendBtn) return;

		const totalSeconds = Math.round(AUTO_SEND_COUNTDOWN_MS / 1000);
		this.countdownRemaining = totalSeconds;
		this.updateSendBtnCountdown();

		this.escHandler = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.cancelCountdown();
		};
		document.addEventListener("keydown", this.escHandler);

		this.countdownTimer = setInterval(() => {
			this.countdownRemaining--;
			if (this.countdownRemaining <= 0) {
				this.cancelCountdown();
				void this.sendNext();
			} else {
				this.updateSendBtnCountdown();
			}
		}, 1000);
	}

	getCountdownRemaining(): number {
		return this.countdownRemaining;
	}

	cancelCountdown(): void {
		if (this.countdownTimer) {
			clearInterval(this.countdownTimer);
			this.countdownTimer = null;
		}
		if (this.escHandler) {
			document.removeEventListener("keydown", this.escHandler);
			this.escHandler = null;
		}
		this.countdownRemaining = 0;
		if (this.sendBtn) {
			this.sendBtn.textContent = "Send next ▶";
			this.sendBtn.classList.remove("co-countdown-active");
		}
		this.app.workspace.trigger("claude-orchestrator:countdown-tick");
	}

	private checkAutoSend(): void {
		if (!this.claudeIdle) return;
		if (!this.sessionNote) return;
		if (this.countdownRemaining > 0) return;
		if (Date.now() - this.loadedAt < 5000) return;

		const action = autoSendAction(
			this.sessionNote.queueMode,
			null,
			this.sessionNote.queue.length,
		);

		if (action === "send") {
			this.startCountdown();
		} else if (action === "notify") {
			this.notifyUser(`Claude idle — ${this.sessionNote.queue.length} item(s) in queue`);
		}
	}

	private notifyUser(message: string): void {
		new Notice(message);
		try {
			new Notification("Claude Orchestrator", { body: message });
		} catch { /* Notification API may not be available */ }
		const { execFile } = require("child_process") as typeof import("child_process");
		execFile("afplay", ["/System/Library/Sounds/Glass.aiff"], () => {});
	}

	private updateSendBtnCountdown(): void {
		if (!this.sendBtn) return;
		this.sendBtn.textContent = `Cancel (${this.countdownRemaining}s)`;
		this.sendBtn.classList.add("co-countdown-active");
		this.app.workspace.trigger("claude-orchestrator:countdown-tick");
	}

	private onHostFocusIn = () => {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.host) {
				view.host.classList.toggle("is-dimmed", view !== this);
			}
		}
		if (this.project && this.sessionName && this.onTerminalFocus) {
			if (this.sessionNoteLoaded) {
				this.onTerminalFocus(this.project, this.sessionName);
			} else {
				// Session note still loading — wait and retry
				const check = () => {
					if (this.sessionNoteLoaded && this.project && this.sessionName && this.onTerminalFocus) {
						this.onTerminalFocus(this.project, this.sessionName);
					} else {
						setTimeout(check, 50);
					}
				};
				setTimeout(check, 50);
			}
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
		this.themeObserver?.disconnect();
		this.themeObserver = null;
		this.host?.removeEventListener("focusin", this.onHostFocusIn);
		this.host?.removeEventListener("focusout", this.onHostFocusOut);
		this.host = null;
		this.historyPanel = null;
		this.queuePanel = null;
		this.queueList = null;
		this.sendBtn = null;
		this.cancelCountdown();
		this.sessionNote = null;
		this.pinLabel = null;
		this.termFocusIndicator = null;
		this.ptyGen++; // invalidate pending callbacks
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.disposePty();
		this.ptyModule = null;
		this.term?.dispose();
		this.term = null;
		this.fitAddon = null;
		this.xtermReady = false;
	}
}
