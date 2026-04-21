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
	quickReplyLabel,
	cancelCopyModeArgs,
	queueModeLabel,
	fetchPtyUsage,
	getPtyStatus,
	ptyStatusMessage,
	parseQueueItemSegments,
	autoSendAction,
	AUTO_SEND_COUNTDOWN_MS,
	execTmux,
	filterSlashCommands,
	stripTimestamp,
	handleTerminalScrollKey,
	wheelDeltaToLines,
	classifyAcKey,
	escapeLeadingBang,
	projectFromSessionName,
	tmuxLs,
	parseAllTmuxSessions,
	pickRecoverySession,
	terminalTheme,
	QUEUE_MODES,
	SessionLifecycle,
} from "./utils";
import type { ProjectRegistry, QueueMode, StopReason, SlashCommandEntry, ThemeName } from "./utils";
import { Terminal } from "@xterm/xterm";
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
	private ptyProcess: IPty | null = null;
	private ptyListeners: { dispose(): void }[] = [];
	private ptyGen = 0;
	private lifecycle = new SessionLifecycle();
	private resizeObserver: ResizeObserver | null = null;
	private pluginDir: string;
	private ptyModule: typeof import("node-pty") | null = null;
	private awaitingRestart = false;
	private project: string | null = null;
	private sessionName: string | null = null;
	private xtermReady = false;
	private stateSeenPreOpen = false;
	private host: HTMLElement | null = null;
	private getSettings?: () => { simpleMode: boolean; projects: ProjectRegistry; quickReplyKeys: string[]; slashCommands: SlashCommandEntry[]; playSoundOnAsking: boolean; theme: ThemeName };
	private historyPanel: HTMLElement | null = null;
	private queuePanel: HTMLElement | null = null;
	private queueList: HTMLElement | null = null;
	private sessionNote: SessionNote | null = null;
	private termFocusIndicator: HTMLElement | null = null;
	private modeBtn: HTMLElement | null = null;
	private sendBtn: HTMLElement | null = null;
	private countdownEl: HTMLElement | null = null;
	private countdownTimer: ReturnType<typeof setInterval> | null = null;
	private countdownRemaining = 0;
	private escHandler: ((e: KeyboardEvent) => void) | null = null;
	private claudeIdle = false;
	private loadedAt = 0;
	private fitTerminal(): void {
		if (!this.term || !this.host) return;
		/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- xterm internal API (same pattern as FitAddon) */
		const dims = (this.term as any)._core?._renderService?.dimensions;
		if (!dims || dims.css.cell.width === 0 || dims.css.cell.height === 0) return;
		const cols = Math.max(2, Math.floor(this.host.clientWidth / dims.css.cell.width));
		const rows = Math.max(1, Math.floor(this.host.clientHeight / dims.css.cell.height));
		/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
		if (this.term.cols !== cols || this.term.rows !== rows) {
			this.term.resize(cols, rows);
		}
	}

	private fitAndResize(): void {
		if (!this.host || this.host.clientWidth < 50) return;
		this.fitTerminal();
		if (this.term && this.ptyProcess) {
			try { this.ptyProcess.resize(this.term.cols, this.term.rows); } catch { /* ignore */ }
		}
		if (this.sessionName && this.term) {
			void execTmux([
				"resize-window", "-t", this.sessionName,
				"-x", String(this.term.cols), "-y", String(this.term.rows),
			]).catch(() => {});
		}
	}

	private debouncedFit = debounce(() => this.fitAndResize(), 150, true);

	constructor(
		leaf: WorkspaceLeaf,
		pluginDir: string,
		getSettings?: () => { simpleMode: boolean; projects: ProjectRegistry; quickReplyKeys: string[]; slashCommands: SlashCommandEntry[]; playSoundOnAsking: boolean; theme: ThemeName },
	) {
		super(leaf);
		this.pluginDir = pluginDir;
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
		const { gen } = this.lifecycle.beginSwitch(normalized.project, normalized.sessionName);
		this.project = normalized.project;
		this.sessionName = normalized.sessionName;
		if (!this.xtermReady) {
			this.stateSeenPreOpen = true;
		}
		await super.setState(state, result);
		if (this.xtermReady && !this.ptyProcess) {
			void this.spawnShell();
			void this.loadSessionNote(gen);
		}
	}

	getProject(): string | null {
		return this.project;
	}

	getSessionName(): string | null {
		return this.sessionName;
	}

	updateSessionName(newName: string): void {
		this.sessionName = newName;
		/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian internal API */
		(this.leaf as any).updateHeader?.();
		/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
		void this.loadSessionNote();
	}

	focusTerminal(): void {
		this.term?.scrollToBottom();
		// If queue panel is active, focus the input box instead of terminal.
		const queueInput = this.queuePanel?.querySelector(".co-queue-input:not(.co-queue-edit-input)") as HTMLElement | null;
		if (queueInput) {
			queueInput.focus();
		} else {
			this.term?.focus();
		}
	}

	setProject(project: string | null, sessionName?: string): void {
		const sn = sessionName ?? project;
		const { gen, needsSave } = this.lifecycle.beginSwitch(project, sn);
		this.project = project;
		this.sessionName = sn;
		/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian internal API for tab title refresh */
		(this.leaf as any).updateHeader?.();
		/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
		if (this.xtermReady) {
			void (async () => {
				if (needsSave) await this.saveSessionNote();
				if (this.lifecycle.isStale(gen)) return;
				void this.spawnShell();
				await this.loadSessionNote(gen);
			})();
		}
	}

	applyTheme(theme: ThemeName): void {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (container) container.dataset.theme = theme;
		if (this.term) this.term.options.theme = terminalTheme(theme);
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.style.padding = "0";
		container.style.display = "flex";
		container.style.flexDirection = "column";
		container.style.overflow = "hidden";
		container.dataset.theme = this.getSettings?.().theme ?? "obsidian";

		this.registerSessionNoteEvents();
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.fitTerminal();
				this.debouncedFit();
				setTimeout(() => this.fitAndResize(), 300);
			}),
		);

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
		const arrow = header.createSpan({ cls: "co-panel-arrow" });
		setIcon(arrow, "chevron-down");
		header.createSpan({ text: " History" });
		header.addEventListener("click", () => {
			const content = this.historyPanel?.querySelector(".co-history-content") as HTMLElement | null;
			if (content) {
				const collapsed = content.style.display === "none";
				content.style.display = collapsed ? "block" : "none";
				setIcon(arrow, collapsed ? "chevron-down" : "chevron-right");
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
			this.fitTerminal();
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

		host.addEventListener("wheel", (e) => {
			if (!this.term) return;
			const lines = wheelDeltaToLines(e.deltaY, e.deltaMode);
			if (lines !== 0) this.term.scrollLines(lines);
			e.preventDefault();
			e.stopPropagation();
		}, { passive: false });
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
			this.fitTerminal();
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

		this.termFocusIndicator = queueHeader.createSpan({ cls: "co-term-indicator" });
		setIcon(this.termFocusIndicator, "chevron-up");
		this.termFocusIndicator.style.visibility = "hidden";

		this.queueList = this.queuePanel.createDiv({ cls: "co-queue-list" });

		// Queue bar: Mode | Sep | Pin | Quick | Send
		const queueBar = this.queuePanel.createDiv({ cls: "co-queue-bar" });

		// Mode group
		const modeGroup = queueBar.createDiv({ cls: "co-queue-bar-group" });
		modeGroup.createSpan({ cls: "co-queue-bar-label", text: "Mode" });
		this.modeBtn = modeGroup.createDiv({ cls: "segmented" });
		this.modeBtn.setAttribute("role", "tablist");
		this.modeBtn.setAttribute("aria-label", "Queue mode");
		for (const m of QUEUE_MODES) {
			const btn = this.modeBtn.createEl("button", { text: queueModeLabel(m) });
			btn.setAttribute("role", "tab");
			btn.dataset.value = m;
			btn.addEventListener("click", () => {
				if (!this.sessionNote) return;
				this.sessionNote.queueMode = m;
				this.cancelCountdown();
				this.updateModeBtn();
				void this.saveSessionNote();
				this.checkAutoSend();
			});
		}
		this.updateModeBtn();

		// Separator
		queueBar.createSpan({ cls: "co-queue-bar-sep" });

		// Pin chip — always points to this session's note
		const pinChipGroup = queueBar.createDiv({ cls: "co-queue-bar-group co-queue-bar-shrinkable" });
		const pinChip = pinChipGroup.createDiv({ cls: "co-pin-chip" });
		const pinIcon = pinChip.createSpan();
		setIcon(pinIcon, "pin");
		const pinLabel = pinChip.createSpan({ cls: "co-pin-label" });
		pinLabel.textContent = this.sessionName ?? "session";

		pinChip.addEventListener("click", () => {
			const folder = this.vaultFolder();
			if (folder === null || !this.sessionName) return;
			const notePath = sessionNotePath(folder, this.sessionName);
			const file = this.app.vault.getAbstractFileByPath(notePath);
			if (file instanceof TFile) {
				void this.app.workspace.getLeaf("tab").openFile(file);
			}
		});

		// Quick reply group
		const quickGroup = queueBar.createDiv({ cls: "co-queue-bar-group" });
		quickGroup.createSpan({ cls: "co-queue-bar-label", text: "Quick" });
		const quickReplyGroup = quickGroup.createDiv({ cls: "co-quick-reply-group" });
		const keys = this.getSettings?.().quickReplyKeys ?? [...QUICK_REPLY_KEYS];
		for (const key of keys) {
			const btn = quickReplyGroup.createEl("button", {
				cls: "btn",
				text: quickReplyLabel(key),
			});
			btn.dataset.size = "sm";
			btn.dataset.variant = "secondary";
			btn.addEventListener("click", () => { void this.sendQuickReply(key); });
		}

		// Send group (right-aligned)
		const sendGroup = queueBar.createDiv({ cls: "co-queue-bar-send" });
		this.sendBtn = sendGroup.createEl("button", {
			cls: "btn",
		});
		this.sendBtn.createSpan({ text: "Send next" });
		const sendIcon = this.sendBtn.createSpan();
		setIcon(sendIcon, "play");
		this.sendBtn.dataset.variant = "primary";
		this.sendBtn.dataset.size = "md";
		this.sendBtn.addEventListener("click", () => {
			if (this.countdownTimer) {
				this.cancelCountdown();
			} else {
				void this.sendNext();
			}
		});

		const addRow = this.queuePanel.createDiv({ cls: "co-queue-add" });
		const input = addRow.createEl("textarea", {
			placeholder: "Add to queue\u2026  /  slash for commands  /  \u2191 for history",
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
			cls: "icon-btn",
		});
		setIcon(addBtn, "plus");
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
		// History prefill (shell-like ↑/↓ navigation)
		let histIdx = -1;
		let savedInput = "";

		const historyPrefill = (direction: "up" | "down"): boolean => {
			if (!this.sessionNote || this.sessionNote.history.length === 0) return false;
			const hist = this.sessionNote.history;
			if (direction === "up") {
				if (histIdx === -1) savedInput = input.value;
				const next = histIdx === -1 ? hist.length - 1 : histIdx - 1;
				if (next < 0) return true;
				histIdx = next;
			} else {
				if (histIdx === -1) return false;
				const next = histIdx + 1;
				if (next >= hist.length) {
					histIdx = -1;
					input.value = savedInput;
					requestAnimationFrame(autoResize);
					return true;
				}
				histIdx = next;
			}
			input.value = stripTimestamp(hist[histIdx]!.text);
			requestAnimationFrame(autoResize);
			return true;
		};

		input.addEventListener("input", () => { histIdx = -1; });

		let composing = false;
		input.addEventListener("compositionstart", () => { composing = true; });
		input.addEventListener("compositionend", () => { composing = false; });
		addBtn.addEventListener("click", doAdd);
		input.addEventListener("keydown", (e) => {
			if (acDropdown && acItems.length > 0) {
				const action = classifyAcKey(e.key, e.shiftKey);
				if (action === "next") {
					e.preventDefault();
					acSelected = (acSelected + 1) % acItems.length;
					renderAc();
					return;
				}
				if (action === "prev") {
					e.preventDefault();
					acSelected = (acSelected - 1 + acItems.length) % acItems.length;
					renderAc();
					return;
				}
				if (action === "accept") {
					e.preventDefault();
					input.value = acItems[acSelected]!.command + " ";
					closeAc();
					requestAnimationFrame(autoResize);
					return;
				}
				if (action === "close") {
					e.preventDefault();
					closeAc();
					return;
				}
			}
			if (e.key === "PageUp" || e.key === "PageDown") {
				e.preventDefault();
				this.term?.scrollPages(e.key === "PageUp" ? -1 : 1);
				return;
			}
			if (e.key === "ArrowUp" && !e.shiftKey) {
				if (historyPrefill("up")) { e.preventDefault(); return; }
			}
			if (e.key === "ArrowDown" && !e.shiftKey) {
				if (historyPrefill("down")) { e.preventDefault(); return; }
			}
			if (e.key === "Enter" && !e.shiftKey && !composing && !e.isComposing) { e.preventDefault(); doAdd(); }
		});
		input.addEventListener("blur", () => { setTimeout(closeAc, 150); });
	}

	private initializeTerminal(): void {
		if (!this.host) return;

		this.term = new Terminal({
			cursorBlink: true,
			fontFamily: "Menlo, Monaco, 'Courier New', monospace",
			fontSize: 13,
			lineHeight: 1.2,
			theme: terminalTheme(this.getSettings?.().theme ?? "obsidian"),
		});
		this.term.open(this.host);
		requestAnimationFrame(() => {
			this.fitTerminal();
			requestAnimationFrame(() => this.fitTerminal());
		});
		setTimeout(() => this.fitAndResize(), 300);

		this.term.attachCustomKeyEventHandler((ev) =>
			handleTerminalScrollKey(ev.key, (n) => this.term?.scrollPages(n)),
		);

		this.term.textarea?.addEventListener("focus", () => {
			if (this.termFocusIndicator) this.termFocusIndicator.style.visibility = "";
		});
		this.term.textarea?.addEventListener("blur", () => {
			if (this.termFocusIndicator) this.termFocusIndicator.style.visibility = "hidden";
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

		this.resizeObserver = new ResizeObserver(() => {
			this.fitTerminal();
			this.debouncedFit();
		});
		this.resizeObserver.observe(this.host);

		this.xtermReady = true;

		if (this.stateSeenPreOpen) {
			void this.spawnShell();
			void this.loadSessionNote(this.lifecycle.gen);
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

		// Recovery: if state was lost (e.g. "Reload without saving"), try to
		// find an unclaimed tmux session matching a registered project.
		if (!this.sessionName) {
			await this.tryRecoverSession();
		}

		// Recovery: if we have a session name but lost the project, reverse-map it.
		if (this.sessionName && !this.project) {
			const projects = this.getSettings?.()?.projects;
			if (projects) {
				const recovered = projectFromSessionName(this.sessionName, projects);
				if (recovered) {
					this.project = recovered;
					/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian internal API */
					(this.leaf as any).updateHeader?.();
					/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
					void this.loadSessionNote();
				}
			}
		}

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

		requestAnimationFrame(() => this.fitAndResize());
		setTimeout(() => this.fitAndResize(), 300);

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

	private async tryRecoverSession(): Promise<void> {
		try {
			const output = await tmuxLs();
			const sessions = parseAllTmuxSessions(output);
			const projects = this.getSettings?.()?.projects;
			if (!projects || sessions.length === 0) return;

			const claimedNames = new Set<string>();
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
				const view = leaf.view;
				if (view instanceof TerminalView && view !== this && view.getSessionName()) {
					claimedNames.add(view.getSessionName()!);
				}
			}

			const match = pickRecoverySession(sessions, projects, claimedNames);
			if (!match) return;

			const { gen } = this.lifecycle.beginSwitch(match.project, match.sessionName);
			this.project = match.project;
			this.sessionName = match.sessionName;
			/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian internal API */
			(this.leaf as any).updateHeader?.();
			/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
			void this.loadSessionNote(gen);
		} catch {
			// tmux not available — keep plain shell
		}
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

	private async loadSessionNote(gen?: number): Promise<void> {
		if (!this.project || !this.sessionName) return;
		const myGen = gen ?? this.lifecycle.gen;
		this.sessionNoteLoaded = false;
		await this.ensureSessionNote();
		if (this.lifecycle.isStale(myGen)) return;
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
		if (this.lifecycle.isStale(myGen)) return;
		this.sessionNote = parseSessionNote(content, this.sessionName);
		if (this.sessionNote.session !== this.sessionName) {
			this.sessionNote.session = this.sessionName;
			void this.saveSessionNote();
		}
		this.claudeIdle = this.sessionNote.status === "idle";
		this.loadedAt = Date.now();
		this.sessionNoteLoaded = true;
		this.renderHistory();
		this.renderQueue();
		this.updateModeBtn();
		/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian internal API */
		(this.leaf as any).updateHeader?.();
		/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
		this.checkAutoSend();
		if (this.claudeIdle && this.sessionNote.queue.length > 0) {
			setTimeout(() => this.checkAutoSend(), 5500);
		}
	}

	private async saveSessionNote(): Promise<void> {
		if (!this.project || !this.sessionName || !this.sessionNote) return;
		this.lifecycle.markDirty();
		const folder = this.vaultFolder();
		if (folder === null) return;
		const notePath = sessionNotePath(folder, this.sessionName);
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (file instanceof TFile) {
			this.savingSessionNote = true;
			const p = this.app.vault.modify(
				file,
				serializeSessionNote(this.sessionNote),
			).then(() => {
				this.savingSessionNote = false;
				this.lifecycle.markClean();
			}, (err) => {
				this.savingSessionNote = false;
				throw err;
			});
			this.lifecycle.trackSave(p);
			await p;
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
			const cls = item.completed ? "co-completed" : "co-in-progress";
			const iconEl = row.createSpan({ cls: `co-history-icon ${cls}` });
			setIcon(iconEl, item.completed ? "check" : "loader");
			const { stamp, body } = extractTimestamp(item.text);
			if (stamp) {
				row.createSpan({ cls: "co-timestamp", text: stamp });
			}
			const textSpan = row.createSpan({ cls: "co-history-text co-collapsed" });
			const segments = parseQueueItemSegments(body);
			if (segments.some((s) => s.type === "image")) {
				for (const seg of segments) {
					if (seg.type === "text") {
						textSpan.createSpan({ text: seg.content });
					} else {
						this.renderEmbedImg(textSpan, seg.content);
					}
				}
			} else {
				textSpan.textContent = body;
			}
			textSpan.addEventListener("click", () => {
				textSpan.classList.toggle("co-collapsed");
			});

			// Copy-to-queue button
			const copyBtn = row.createEl("button", {
				cls: "icon-btn co-history-copy-btn",
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

	private updateModeBtn(): void {
		if (!this.modeBtn) return;
		const mode: QueueMode = this.sessionNote?.queueMode ?? "manual";
		this.modeBtn.dataset.value = mode;
		const buttons = Array.from(this.modeBtn.querySelectorAll("button"));
		for (const b of buttons) {
			if (b.dataset.value === mode) {
				b.dataset.active = "true";
			} else {
				delete b.dataset.active;
			}
		}
	}

	private renderQueue(): void {
		if (!this.queueList || !this.sessionNote) return;
		this.queueList.empty();

		if (this.sendBtn) {
			this.sendBtn.dataset.variant = this.sessionNote.queue.length > 0 ? "primary" : "secondary";
		}

		if (this.sessionNote.queue.length === 0) {
			this.queueList.createDiv({ cls: "co-empty", text: "Queue empty." });
		} else {
			this.sessionNote.queue.forEach((text, idx) => {
				this.renderQueueItem(this.queueList!, text, idx);
			});
		}

		if (this.sessionNote.status === "waiting_for_user") {
			const banner = this.queueList.createDiv({ cls: "co-ask-banner" });
			banner.createDiv({ cls: "co-ask-banner-dot" });
			const textEl = banner.createDiv({ cls: "co-ask-banner-text" });
			const strong = textEl.createEl("strong");
			const pauseIcon = strong.createSpan();
			setIcon(pauseIcon, "pause");
			strong.appendText(" Claude is waiting for your reply.");
			textEl.appendText(" Use Quick Reply or type below.");
		}
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
					this.renderEmbedImg(textSpan, seg.content);
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
				cls: "icon-btn co-move-btn",
			});
			setIcon(upBtn, "arrow-up");
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
				cls: "icon-btn co-move-btn",
			});
			setIcon(downBtn, "arrow-down");
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
			cls: "icon-btn",
		});
		setIcon(editBtn, "pencil");
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
				cls: "icon-btn",
			});
			setIcon(saveBtn, "check");
			saveBtn.dataset.tone = "success";
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
			cls: "icon-btn",
		});
		setIcon(removeBtn, "x");
		removeBtn.dataset.tone = "danger";
		removeBtn.addEventListener("click", () => {
			this.sessionNote?.queue.splice(idx, 1);
			this.renderQueue();
			void this.saveSessionNote();
		});
	}

	private renderEmbedImg(parent: HTMLElement, ref: string): void {
		const filename = ref.split("/").pop() ?? ref;
		const chip = parent.createSpan({ cls: "co-embed-img" });
		const imgIcon = chip.createSpan();
		setIcon(imgIcon, "image");
		chip.appendText(` ${filename}`);
		chip.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.app.workspace.openLinkText(ref, "", false);
		});
	}

	// --- Send next ---

	async sendNext(): Promise<void> {
		if (!this.sessionNote || !this.sessionName) return;
		if (this.sessionNote.queue.length === 0) return;

		this.cancelCountdown();
		this.claudeIdle = false;
		this.sessionNote.status = "running";
		if (this.host) delete this.host.dataset.ask;
		const task = this.sessionNote.queue.shift()!;

		// Move to history as in-progress
		this.sessionNote.history.push({ text: task, completed: false });
		this.renderHistory();
		this.renderQueue();
		await this.saveSessionNote();

		// Strip timestamp prefix before injecting (e.g. "[2026-04-15 23:15] actual text")
		const taskText = escapeLeadingBang(
			task.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /, ""),
		);

		const target = this.sessionName;

		this.term?.scrollToBottom();

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
		const target = this.lifecycle.captureTarget();
		if (!target) return;

		if (this.sessionNote) {
			this.sessionNote.status = "running";
			this.claudeIdle = false;
			if (this.host) delete this.host.dataset.ask;
			this.renderQueue();
			void this.saveSessionNote();
		}

		const { textArgs, enterArgs } = buildQuickReplyTmuxArgs(target, escapeLeadingBang(key));

		this.term?.scrollToBottom();
		await execTmux(cancelCopyModeArgs(target)).catch(() => {});
		try {
			await execTmux(textArgs);
			if (enterArgs.length > 0) {
				await new Promise((r) => setTimeout(r, 150));
				await execTmux(enterArgs);
			}
		} catch (err) {
			new Notice(`Quick reply failed: ${(err as Error).message}`);
		}
	}

	onStopSignal(stopReason: StopReason | null): void {
		if (!this.sessionNote) return;

		this.claudeIdle = stopReason !== "asking";
		this.sessionNote.status = stopReason === "asking" ? "waiting_for_user" : "idle";

		if (this.host) {
			if (stopReason === "asking") {
				this.host.dataset.ask = "true";
			} else {
				delete this.host.dataset.ask;
			}
		}

		if (stopReason === "done") {
			const last = this.sessionNote.history[this.sessionNote.history.length - 1];
			if (last && !last.completed) {
				last.completed = true;
			}
		}

		this.renderHistory();
		this.renderQueue();
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

		if (stopReason === "asking" && this.getSettings?.().playSoundOnAsking) {
			this.playSound();
		}
	}

	private startCountdown(): void {
		this.cancelCountdown();
		if (!this.sendBtn?.parentElement) return;

		const totalSeconds = Math.round(AUTO_SEND_COUNTDOWN_MS / 1000);
		this.countdownRemaining = totalSeconds;

		const parent = this.sendBtn.parentElement;
		const pill = parent.createDiv({ cls: "co-countdown" });
		pill.createDiv({ cls: "co-countdown-dot" });
		pill.createSpan({ cls: "co-countdown-label", text: `Auto-send in ${totalSeconds}s` });
		const cancelBtn = pill.createEl("button", { cls: "icon-btn" });
		setIcon(cancelBtn, "x");
		cancelBtn.addEventListener("click", () => this.cancelCountdown());

		parent.insertBefore(pill, this.sendBtn);
		this.sendBtn.style.display = "none";
		this.countdownEl = pill;

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
				this.updateCountdownLabel();
			}
		}, 1000);

		this.app.workspace.trigger("claude-orchestrator:countdown-tick");
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
		this.countdownEl?.remove();
		this.countdownEl = null;
		if (this.sendBtn) {
			this.sendBtn.style.display = "";
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

	private playSound(): void {
		const { execFile } = require("child_process") as typeof import("child_process");
		execFile("afplay", ["/System/Library/Sounds/Glass.aiff"], () => {});
	}

	private notifyUser(message: string): void {
		new Notice(message);
		try {
			new Notification("Claude Orchestrator", { body: message });
		} catch { /* Notification API may not be available */ }
		this.playSound();
	}

	private updateCountdownLabel(): void {
		const label = this.countdownEl?.querySelector(".co-countdown-label");
		if (label) label.textContent = `Auto-send in ${this.countdownRemaining}s`;
		this.app.workspace.trigger("claude-orchestrator:countdown-tick");
	}

	private onHostFocusIn = () => {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.host) {
				view.host.classList.toggle("is-dimmed", view !== this);
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
		await this.lifecycle.flush();
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
		this.sendBtn = null;
		this.countdownEl = null;
		this.cancelCountdown();
		this.sessionNote = null;
		this.termFocusIndicator = null;
		this.ptyGen++; // invalidate pending callbacks
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.disposePty();
		this.ptyModule = null;
		this.term?.dispose();
		this.term = null;
		this.xtermReady = false;
	}
}
