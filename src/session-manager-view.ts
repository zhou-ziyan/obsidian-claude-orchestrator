import { FuzzySuggestModal, ItemView, Notice, setIcon, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import type { App } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";
import {
	tmuxLs,
	parseAllTmuxSessions,
	groupSessionsByProject,
	restorableSessionNames,
	sessionNotePath,
	sessionDirPath,
	parseSessionNote,
	serializeSessionNote,
	projectFromSessionName,
	formatRelativeTime,
	validateProjectKey,
	addProject,
	updateProjectConfig,
	removeProject,
	normalizeVaultFolder,
	getPtyUsage,
	ptyLevel,
	isSessionIdle,
	extractSessionPreview,
	execTmux,
	queueModeLabel,
	applySortOrder,
	SessionGroup,
	SessionInfo,
	sessionStatusDisplay,
	sessionsMissingNotes,
	createDefaultSessionNote,
	archiveSessionNotePath,
} from "./utils";
import { findTerminalLeafBySession, collectOpenSessionNames } from "./workspace-helpers";
import type { ProjectConfig, PtyLevel } from "./utils";
import type ClaudeOrchestratorPlugin from "./main";

export const VIEW_TYPE_SESSION_MANAGER = "claude-orchestrator-session-manager";

class VaultFolderModal extends FuzzySuggestModal<TFolder> {
	private onChoose: (folder: TFolder) => void;

	constructor(app: App, onChoose: (folder: TFolder) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder("Type to search vault folders…");
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (f instanceof TFolder && !f.isRoot()) {
				folders.push(f);
			}
		}
		folders.sort((a, b) => a.path.localeCompare(b.path));
		return folders;
	}

	getItemText(item: TFolder): string {
		return item.path;
	}

	onChooseItem(item: TFolder): void {
		this.onChoose(item);
	}
}

class SessionNoteModal extends FuzzySuggestModal<TFile> {
	private files: TFile[];
	private onChoose: (file: TFile) => void;

	constructor(app: App, files: TFile[], onChoose: (file: TFile) => void) {
		super(app);
		this.files = files;
		this.onChoose = onChoose;
		this.setPlaceholder("Select a session note to link…");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(item: TFile): string {
		return item.basename;
	}

	onChooseItem(item: TFile): void {
		this.onChoose(item);
	}
}

const POLL_INTERVAL_MS = 30_000;

// Timestamp pattern used in queue/history items: [YYYY-MM-DD HH:MM]
const TIMESTAMP_RE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/;

export class SessionManagerView extends ItemView {
	private plugin: ClaudeOrchestratorPlugin;
	private groups: SessionGroup[] = [];
	private listEl: HTMLElement | null = null;
	private ptyEl: HTMLElement | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private collapsedProjects = new Set<string>();
	private editing = false;
	private focusedSession: string | null = null;
	private sendBtns = new Map<string, HTMLElement>();
	private openSettings = new Set<string>();

	constructor(leaf: WorkspaceLeaf, plugin: ClaudeOrchestratorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_SESSION_MANAGER;
	}

	getDisplayText(): string {
		return "Session Manager";
	}

	getIcon(): string {
		return "layout-grid";
	}

	applyTheme(theme: string): void {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (container) container.dataset.theme = theme;
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("co-sm-container");
		container.dataset.theme = this.plugin.settings.theme;

		// Header
		const header = container.createDiv({ cls: "co-sm-header" });
		header.createSpan({ cls: "co-sm-title", text: "Sessions" });
		const headerActions = header.createDiv({ cls: "co-sm-header-actions" });
		const refreshBtn = headerActions.createEl("button", {
			cls: "icon-btn",
		});
		setIcon(refreshBtn, "rotate-cw");
		refreshBtn.title = "Refresh";
		refreshBtn.addEventListener("click", () => { void this.refresh(); });

		const addBtn = headerActions.createEl("button", {
			cls: "icon-btn",
		});
		setIcon(addBtn, "plus");
		addBtn.title = "Add project";
		addBtn.addEventListener("click", () => { this.showProjectForm(); });

		// Session list
		this.listEl = container.createDiv({ cls: "co-sm-list" });

		// PTY usage indicator (footer)
		this.ptyEl = container.createDiv({ cls: "co-sm-pty" });

		// Initial load
		await this.refresh();

		// Workspace events — real-time sync for managed sessions
		this.registerEvent(
			this.app.workspace.on("layout-change", () => { void this.refresh(); }),
		);

		// Session note changes
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path.includes("/sessions/") && file.path.endsWith(".md")) {
					void this.refresh();
				}
			}),
		);

		// Countdown tick — update Send buttons without full refresh
		/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- custom workspace event */
		this.registerEvent(
			this.app.workspace.on("claude-orchestrator:countdown-tick" as any, () => {
				this.updateCountdownButtons();
			}),
		);
		/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */

		// Low-frequency polling for external tmux changes
		this.pollTimer = setInterval(() => { void this.refresh(); }, POLL_INTERVAL_MS);
	}

	async onClose() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.listEl = null;
	}

	async refresh() {
		if (!this.listEl || this.editing) return;

		// 1. Get all tmux sessions + PTY usage in parallel
		const [tmuxOutput, ptyUsage] = await Promise.all([
			tmuxLs(),
			getPtyUsage(),
		]);
		const allSessions = parseAllTmuxSessions(tmuxOutput);

		// Render PTY indicator
		this.renderPty(ptyUsage.used, ptyUsage.max);

		// 2. Collect open terminal panel session names
		const openNames = collectOpenSessionNames(this.app.workspace);

		const projects = this.plugin.settings.projects;

		// 3. Auto-create missing session notes for managed sessions
		const existingPaths = new Set<string>();
		for (const s of allSessions) {
			const project = projectFromSessionName(s.name, projects);
			if (!project) continue;
			const config = projects[project];
			if (!config) continue;
			const np = sessionNotePath(config.vaultFolder, s.name);
			if (this.app.vault.getAbstractFileByPath(np)) existingPaths.add(np);
		}
		const missing = sessionsMissingNotes(
			allSessions.map((s) => s.name),
			projects,
			existingPaths,
		);
		for (const m of missing) {
			try {
				if (!this.app.vault.getAbstractFileByPath(m.dirPath)) {
					await this.app.vault.createFolder(m.dirPath);
				}
				await this.app.vault.create(m.notePath, createDefaultSessionNote(m.sessionName));
			} catch { /* race: another view may have created it */ }
		}

		// 4. Read session notes for managed sessions
		const noteData = new Map<string, {
			queueCount: number;
			lastActivity: string | null;
			preview: string | null;
			displayName: string | null;
			status: import("./utils").SessionStatus;
			queueMode: import("./utils").QueueMode;
		}>();
		for (const s of allSessions) {
			const project = projectFromSessionName(s.name, projects);
			if (!project) continue;
			const config = projects[project];
			if (!config) continue;
			const notePath = sessionNotePath(config.vaultFolder, s.name);
			const file = this.app.vault.getAbstractFileByPath(notePath);
			if (!(file instanceof TFile)) continue;
			try {
				const content = await this.app.vault.read(file);
				const note = parseSessionNote(content, s.name);
				// Extract last activity from most recent history/queue timestamp
				let lastActivity: string | null = null;
				const allItems = [
					...note.history.map((h) => h.text),
					...note.queue,
				];
				for (let i = allItems.length - 1; i >= 0; i--) {
					const m = allItems[i]?.match(TIMESTAMP_RE);
					if (m?.[1]) {
						lastActivity = m[1];
						break;
					}
				}
				noteData.set(s.name, {
					queueCount: note.queue.length,
					lastActivity,
					preview: extractSessionPreview(note),
					displayName: note.displayName || null,
					status: note.status,
					queueMode: note.queueMode,
				});
			} catch {
				// Note read failed — skip
			}
		}

		// 5. Group
		this.groups = groupSessionsByProject(allSessions, openNames, noteData, projects);

		// 6. Render
		this.render();
	}

	private inactiveCollapsed = true;

	private render() {
		if (!this.listEl) return;
		this.listEl.empty();
		this.sendBtns.clear();

		if (this.groups.length === 0 && Object.keys(this.plugin.settings.projects).length === 0) {
			this.listEl.createDiv({
				cls: "co-sm-empty",
				text: "No projects registered. Click + to add one.",
			});
			return;
		}

		const active: SessionGroup[] = [];
		const inactive: SessionGroup[] = [];
		for (const group of this.groups) {
			if (group.project === "Unmanaged" || group.sessions.length > 0) {
				active.push(group);
			} else {
				inactive.push(group);
			}
		}

		for (const group of active) {
			this.renderGroup(group);
		}

		if (inactive.length > 0) {
			this.renderInactiveSection(inactive);
		}
	}

	private renderInactiveSection(groups: SessionGroup[]) {
		if (!this.listEl) return;
		const section = this.listEl.createDiv({ cls: "co-sm-inactive-section" });
		const header = section.createDiv({ cls: "co-sm-inactive-header" });
		const inactiveArrow = header.createSpan({ cls: "co-sm-arrow" });
		setIcon(inactiveArrow, this.inactiveCollapsed ? "chevron-right" : "chevron-down");
		header.createSpan({ text: `Inactive projects (${groups.length})` });
		header.addEventListener("click", () => {
			this.inactiveCollapsed = !this.inactiveCollapsed;
			this.render();
		});

		if (this.inactiveCollapsed) return;

		for (const group of groups) {
			this.renderGroup(group);
		}
	}

	private renderPty(used: number, max: number) {
		if (!this.ptyEl) return;
		this.ptyEl.empty();

		if (max <= 0) return;

		const level: PtyLevel = ptyLevel(used, max);
		const pct = Math.min(100, Math.round((used / max) * 100));

		const label = this.ptyEl.createSpan({ cls: `co-sm-pty-label co-pty-${level}` });
		label.textContent = `PTY ${used} / ${max}`;

		const bar = this.ptyEl.createDiv({ cls: "co-sm-pty-bar" });
		const fill = bar.createDiv({ cls: `co-sm-pty-fill co-pty-${level}` });
		fill.style.width = `${pct}%`;
	}

	private renderGroup(group: SessionGroup) {
		if (!this.listEl) return;
		const collapsed = this.collapsedProjects.has(group.project);
		const isManaged = group.project !== "Unmanaged" && group.project in this.plugin.settings.projects;

		const groupEl = this.listEl.createDiv({ cls: "co-sm-group" });

		// Group header
		const groupHeader = groupEl.createDiv({ cls: "co-sm-group-header" });
		const groupArrow = groupHeader.createSpan({ cls: "co-sm-arrow" });
		setIcon(groupArrow, collapsed ? "chevron-right" : "chevron-down");
		groupHeader.createSpan({
			cls: "co-sm-group-name",
			text: group.project,
		});

		if (isManaged) {
			const restorable = restorableSessionNames(group);
			if (restorable.length > 0) {
				const restoreBtn = groupHeader.createEl("button", {
					cls: "icon-btn co-sm-gear",
				});
				setIcon(restoreBtn, "undo-2");
				restoreBtn.title = `Restore ${restorable.length} session(s)`;
				restoreBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					void this.plugin.restoreProjectSessions(group.project).then(() => {
						setTimeout(() => { void this.refresh(); }, 500);
					});
				});
			}

			const panelCount = group.sessions.filter((s) => s.hasPanel).length;
			if (panelCount >= 2) {
				const gatherBtn = groupHeader.createEl("button", {
					cls: "icon-btn co-sm-gear",
				});
				setIcon(gatherBtn, "layout-grid");
				gatherBtn.title = "Gather terminals into one tab group";
				gatherBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					void this.plugin.gatherProjectTerminals(group.project).then(() => {
						setTimeout(() => { void this.refresh(); }, 500);
					});
				});
			}

			const newBtn = groupHeader.createEl("button", {
				cls: "icon-btn co-sm-gear",
			});
			setIcon(newBtn, "plus");
			newBtn.title = "New session";
			newBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.plugin.createNewTerminalForProject(group.project).then(() => {
					setTimeout(() => { void this.refresh(); }, 500);
				});
			});

			const gearBtn = groupHeader.createEl("button", {
				cls: "icon-btn co-sm-gear",
			});
			setIcon(gearBtn, "settings");
			gearBtn.title = "Edit project";
			gearBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.showProjectForm(group.project);
			});
		}

		groupHeader.createSpan({
			cls: "co-sm-group-count",
			text: `${group.sessions.length}`,
		});

		groupHeader.addEventListener("click", () => {
			if (this.collapsedProjects.has(group.project)) {
				this.collapsedProjects.delete(group.project);
			} else {
				this.collapsedProjects.add(group.project);
			}
			this.render();
		});

		if (collapsed) return;

		const sorted = applySortOrder(group.sessions, this.plugin.settings.sessionOrder[group.project] ?? []);
		for (const session of sorted) {
			this.renderSessionCard(groupEl, session, group.project);
		}
	}

	private renderSessionCard(parent: HTMLElement, session: SessionInfo, project?: string) {
		const isFocused = session.name === this.focusedSession;
		const idle = isSessionIdle(session.tmuxActivity);
		let cls = "co-sm-card";
		if (isFocused) cls += " co-sm-card-focused";
		if (idle) cls += " co-sm-card-idle";
		const card = parent.createDiv({ cls });
		card.dataset.sessionName = session.name;
		if (isFocused) {
			requestAnimationFrame(() => card.scrollIntoView({ block: "nearest" }));
		}

		if (project) {
			this.attachDragHandlers(card, parent, project);
		}

		// Top row: name + kill button in top-right corner
		const topRow = card.createDiv({ cls: "co-sm-card-top" });

		const { cls: statusCls, dataStatus } = sessionStatusDisplay(session.hasPanel, session.status);
		const statusDot = topRow.createDiv({ cls: statusCls });
		statusDot.dataset.s = dataStatus;
		const nameRow = topRow.createDiv({ cls: "co-sm-card-name" });
		const displayLabel = session.displayName || session.name.replace(/-(\d+)$/, " #$1");
		const nameSpan = nameRow.createSpan({ text: displayLabel });
		nameSpan.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this.showInlineRename(nameSpan, session);
		});

		const topActions = topRow.createDiv({ cls: "co-sm-card-top-actions" });

		const renameBtn = topActions.createEl("button", {
			cls: "icon-btn co-sm-hover-btn",
		});
		setIcon(renameBtn, "pencil");
		renameBtn.title = "Rename session";
		renameBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.showInlineRename(nameSpan, session);
		});

		if (project) {
			const settingsOpen = this.openSettings.has(session.name);
			const settingsBtn = topActions.createEl("button", {
				cls: settingsOpen ? "icon-btn" : "icon-btn co-sm-hover-btn",
			});
			setIcon(settingsBtn, "settings");
			settingsBtn.title = "Session settings";
			settingsBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				if (this.openSettings.has(session.name)) {
					this.openSettings.delete(session.name);
				} else {
					this.openSettings.add(session.name);
				}
				void this.refresh();
			});
		}

		const killBtn = topActions.createEl("button", {
			cls: "icon-btn co-sm-hover-btn",
		});
		setIcon(killBtn, "x");
		killBtn.dataset.tone = "danger";
		killBtn.title = "Kill session";
		killBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.showKillConfirm(card, session.name);
		});

		// Settings panel (expandable)
		if (project && this.openSettings.has(session.name)) {
			const config = this.plugin.settings.projects[project];
			if (config) {
				const settingsPanel = card.createDiv({ cls: "co-sm-settings" });
				const noteRow = settingsPanel.createDiv({ cls: "co-sm-settings-row" });
				const expectedPath = sessionNotePath(config.vaultFolder, session.name);

				noteRow.createSpan({ cls: "co-sm-settings-label", text: "Session note:" });
				const pathSpan = noteRow.createSpan({ cls: "co-sm-settings-path", text: expectedPath });

				if (session.hasNote) {
					pathSpan.classList.add("co-sm-settings-path-link");
					pathSpan.addEventListener("click", (e) => {
						e.stopPropagation();
						void this.app.workspace.openLinkText(expectedPath, "");
					});
				} else {
					noteRow.createSpan({ cls: "co-sm-settings-warn", text: "⚠ not found" });
					const relinkBtn = settingsPanel.createEl("button", {
						cls: "btn",
						text: "Relink",
					});
					relinkBtn.addEventListener("click", (e) => {
						e.stopPropagation();
						void this.linkSessionNote(session.name, project);
					});
				}
			}
		}

		// Meta row: mode · queue badge · relative time
		const metaRow = card.createDiv({ cls: "co-sm-card-meta" });
		if (session.hasNote) {
			const modeEl = metaRow.createSpan({ cls: "co-sm-card-mode" });
			modeEl.dataset.mode = session.queueMode;
			modeEl.textContent = queueModeLabel(session.queueMode).toUpperCase();

			metaRow.createSpan({ cls: "co-sm-card-dot-sep", text: "·" });

			const queueBadge = metaRow.createSpan({ cls: "co-sm-card-queue-badge" });
			queueBadge.textContent = `Q ${session.queueCount}`;
			if (session.queueCount > 0) queueBadge.dataset.nonzero = "true";

			if (session.lastActivity) {
				metaRow.createSpan({
					cls: "co-sm-card-time",
					text: formatRelativeTime(session.lastActivity),
				});
			}
		} else {
			metaRow.createSpan({
				cls: "co-sm-badge co-sm-unmanaged",
				text: "no session note",
			});
		}

		// Note preview (italic gray)
		if (session.preview) {
			const previewEl = card.createDiv({ cls: "co-sm-card-note" });
			previewEl.textContent = session.preview;
		}

		// Send next / Countdown (below meta/preview, per design reference)
		if (session.hasPanel && session.queueCount > 0) {
			const match = findTerminalLeafBySession(this.app.workspace, session.name);
			const countdown = match?.view.getCountdownRemaining() ?? 0;

			if (countdown > 0) {
				const cdEl = card.createDiv({ cls: "co-sm-card-countdown" });
				cdEl.createSpan({ cls: "co-sm-card-countdown-dot" });
				cdEl.createSpan({ cls: "co-sm-card-countdown-text", text: `Auto-send in ${countdown}s` });
				const cancelBtn = cdEl.createEl("button", { cls: "co-sm-card-countdown-x" });
				setIcon(cancelBtn, "x");
				cancelBtn.title = "Cancel";
				cancelBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					match?.view.cancelCountdown();
				});
				this.sendBtns.set(session.name, cdEl);
			} else {
				const sendBtn = card.createEl("button", { cls: "co-sm-card-send" });
				const sendIconSpan = sendBtn.createSpan({ cls: "co-sm-card-send-icon" });
				setIcon(sendIconSpan, "play");
				sendBtn.createSpan({ text: "Send next" });
				sendBtn.title = "Send next queue item";
				sendBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					void this.sendNextForSession(session.name);
				});
				this.sendBtns.set(session.name, sendBtn);
			}
		}

		card.addEventListener("dblclick", () => {
			if (session.hasPanel) {
				this.focusSession(session.name);
			} else {
				void this.attachSession(session);
			}
		});

	}

	private updateCountdownButtons(): void {
		for (const [sessionName, el] of this.sendBtns) {
			const match = findTerminalLeafBySession(this.app.workspace, sessionName);
			const remaining = match?.view.getCountdownRemaining() ?? 0;
			const parent = el.parentElement;
			if (!parent) continue;

			const isCd = el.classList.contains("co-sm-card-countdown");
			if (remaining > 0 && isCd) {
				const label = el.querySelector(".co-sm-card-countdown-text");
				if (label) label.textContent = `Auto-send in ${remaining}s`;
			} else if (remaining > 0 && !isCd) {
				el.remove();
				const cdEl = parent.createDiv({ cls: "co-sm-card-countdown" });
				cdEl.createSpan({ cls: "co-sm-card-countdown-dot" });
				cdEl.createSpan({ cls: "co-sm-card-countdown-text", text: `Auto-send in ${remaining}s` });
				const cancelBtn = cdEl.createEl("button", { cls: "co-sm-card-countdown-x" });
				setIcon(cancelBtn, "x");
				cancelBtn.title = "Cancel";
				cancelBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					match?.view.cancelCountdown();
				});
				this.sendBtns.set(sessionName, cdEl);
			} else if (remaining <= 0 && isCd) {
				el.remove();
				const sendBtn = parent.createEl("button", { cls: "co-sm-card-send" });
				const sendIconSpan2 = sendBtn.createSpan({ cls: "co-sm-card-send-icon" });
				setIcon(sendIconSpan2, "play");
				sendBtn.createSpan({ text: "Send next" });
				sendBtn.title = "Send next queue item";
				sendBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					void this.sendNextForSession(sessionName);
				});
				this.sendBtns.set(sessionName, sendBtn);
			}
		}
	}

	private attachDragHandlers(card: HTMLElement, groupEl: HTMLElement, project: string): void {
		let startY = 0;
		let dragging = false;
		let placeholder: HTMLElement | null = null;

		const onMouseMove = (e: MouseEvent) => {
			if (!dragging) {
				if (Math.abs(e.clientY - startY) < 5) return;
				dragging = true;
				card.classList.add("co-sm-card-dragging");
				document.body.style.userSelect = "none";
				document.body.style.cursor = "grabbing";
			}

			const cards = Array.from(groupEl.querySelectorAll<HTMLElement>(".co-sm-card"));
			placeholder?.remove();
			placeholder = null;

			for (const c of cards) {
				if (c === card) continue;
				const rect = c.getBoundingClientRect();
				const midY = rect.top + rect.height / 2;
				if (e.clientY < midY) {
					placeholder = document.createElement("div");
					placeholder.classList.add("co-sm-drop-indicator");
					c.before(placeholder);
					return;
				}
			}
			const lastCard = cards[cards.length - 1];
			if (lastCard && lastCard !== card) {
				placeholder = document.createElement("div");
				placeholder.classList.add("co-sm-drop-indicator");
				lastCard.after(placeholder);
			}
		};

		const onMouseUp = () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
			card.classList.remove("co-sm-card-dragging");

			if (!dragging) { placeholder?.remove(); return; }
			dragging = false;

			const cards = Array.from(groupEl.querySelectorAll<HTMLElement>(".co-sm-card"));
			const newOrder = cards.map(c => c.dataset.sessionName).filter((n): n is string => !!n);

			if (placeholder) {
				const phIdx = Array.from(groupEl.children).indexOf(placeholder);
				const cardName = card.dataset.sessionName;
				if (cardName) {
					const filtered = newOrder.filter(n => n !== cardName);
					const insertBefore = phIdx >= 0
						? Array.from(groupEl.children)
							.slice(phIdx + 1)
							.find(el => el instanceof HTMLElement && el.classList.contains("co-sm-card") && el.dataset.sessionName)
						: null;
					const insertIdx = insertBefore instanceof HTMLElement && insertBefore.dataset.sessionName
						? filtered.indexOf(insertBefore.dataset.sessionName)
						: filtered.length;
					filtered.splice(insertIdx, 0, cardName);
					this.plugin.settings.sessionOrder[project] = filtered;
					void this.plugin.saveSettings();
				}
			}
			placeholder?.remove();
			placeholder = null;
			this.render();
		};

		card.addEventListener("mousedown", (e) => {
			if ((e.target as HTMLElement).closest("button, input, .co-sm-card-actions")) return;
			e.preventDefault();
			startY = e.clientY;
			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		});
	}

	private showInlineRename(nameSpan: HTMLElement, session: SessionInfo) {
		const card = nameSpan.closest<HTMLElement>(".co-sm-card");
		if (!card) return;
		card.dataset.renaming = "true";

		const current = session.displayName || "";
		const input = document.createElement("input");
		input.type = "text";
		input.value = current;
		input.placeholder = session.name.replace(/-(\d+)$/, " #$1");
		input.classList.add("co-sm-card-rename");
		nameSpan.replaceWith(input);
		input.focus();
		input.select();

		const hint = card.createDiv({ cls: "co-sm-card-rename-hint", text: "↵ display name · Esc cancel" });

		const topActions = card.querySelector(".co-sm-card-top-actions");
		const originalButtons = topActions ? Array.from(topActions.children) as HTMLElement[] : [];
		originalButtons.forEach(b => { b.style.display = "none"; });

		const confirmBtn = topActions?.createEl("button", { cls: "icon-btn" });
		if (confirmBtn) {
			setIcon(confirmBtn, "check");
			confirmBtn.dataset.tone = "success";
			confirmBtn.title = "Save display name";
		}
		const cancelBtn = topActions?.createEl("button", { cls: "icon-btn" });
		if (cancelBtn) setIcon(cancelBtn, "x");

		const cleanup = () => {
			delete card.dataset.renaming;
			hint.remove();
			confirmBtn?.remove();
			cancelBtn?.remove();
			originalButtons.forEach(b => { b.style.display = ""; });
		};

		const save = () => {
			cleanup();
			const newDisplayName = input.value.trim();
			if (!newDisplayName || newDisplayName === current) {
				void this.refresh();
				return;
			}
			const project = projectFromSessionName(session.name, this.plugin.settings.projects);
			if (project) {
				const config = this.plugin.settings.projects[project];
				if (config) {
					const notePath = sessionNotePath(config.vaultFolder, session.name);
					const file = this.app.vault.getAbstractFileByPath(notePath);
					if (file instanceof TFile) {
						void (async () => {
							const content = await this.app.vault.read(file);
							const note = parseSessionNote(content, session.name);
							note.displayName = newDisplayName;
							await this.app.vault.modify(file, serializeSessionNote(note));
							void this.refresh();
						})();
					}
				}
			}
		};

		const cancel = () => {
			cleanup();
			void this.refresh();
		};

		confirmBtn?.addEventListener("click", (e) => { e.stopPropagation(); save(); });
		cancelBtn?.addEventListener("click", (e) => { e.stopPropagation(); cancel(); });
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); save(); }
			if (e.key === "Escape") { e.preventDefault(); cancel(); }
		});
		input.addEventListener("blur", () => save());
	}

	private showKillConfirm(card: HTMLElement, sessionName: string) {
		card.querySelector(".co-sm-card-confirm")?.remove();
		card.dataset.confirming = "kill";

		const confirm = card.createDiv({ cls: "co-sm-card-confirm" });
		const msg = confirm.createDiv({ cls: "co-sm-card-confirm-msg" });
		msg.appendText("Kill ");
		msg.createSpan({ cls: "co-sm-card-confirm-name", text: `"${sessionName}"` });
		msg.appendText("?");

		const actions = confirm.createDiv({ cls: "co-sm-card-confirm-actions" });

		const cancelBtn = actions.createEl("button", { cls: "btn", text: "Cancel" });
		cancelBtn.dataset.variant = "secondary";
		cancelBtn.dataset.size = "sm";
		cancelBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.dismissKillConfirm(card);
		});

		const closeTabBtn = actions.createEl("button", { cls: "btn", text: "Close tab" });
		closeTabBtn.dataset.variant = "secondary";
		closeTabBtn.dataset.size = "sm";
		closeTabBtn.title = "Close terminal tab but keep tmux session running";
		closeTabBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.dismissKillConfirm(card);
			void this.closeSessionTab(sessionName);
		});

		const archiveBtn = actions.createEl("button", { cls: "btn", text: "Archive" });
		archiveBtn.dataset.tone = "warn";
		archiveBtn.dataset.size = "sm";
		archiveBtn.title = "Kill session, archive note";
		archiveBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.dismissKillConfirm(card);
			void this.killSession(sessionName, "archive");
		});

		const deleteBtn = actions.createEl("button", { cls: "btn", text: "Kill" });
		deleteBtn.dataset.variant = "primary";
		deleteBtn.dataset.tone = "danger";
		deleteBtn.dataset.size = "sm";
		deleteBtn.title = "Kill session, delete note";
		deleteBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.dismissKillConfirm(card);
			void this.killSession(sessionName, "delete");
		});

		setTimeout(() => this.dismissKillConfirm(card), 8000);
	}

	private dismissKillConfirm(card: HTMLElement) {
		delete card.dataset.confirming;
		card.querySelector(".co-sm-card-confirm")?.remove();
	}

	highlightSession(sessionName: string | null) {
		if (this.focusedSession === sessionName) return;
		this.focusedSession = sessionName;
		if (sessionName) {
			const project = projectFromSessionName(sessionName, this.plugin.settings.projects);
			if (project) this.collapsedProjects.delete(project);
		}
		this.render();
	}

	// --- Actions ---

	private focusSession(sessionName: string) {
		const match = findTerminalLeafBySession(this.app.workspace, sessionName);
		if (match) {
			void this.app.workspace.revealLeaf(match.leaf);
			match.view.focusTerminal();
		}
	}

	private async sendNextForSession(sessionName: string) {
		const match = findTerminalLeafBySession(this.app.workspace, sessionName);
		if (match) {
			await match.view.sendNext();
			setTimeout(() => { void this.refresh(); }, 300);
		}
	}

	private async attachSession(session: SessionInfo) {
		const project = projectFromSessionName(session.name, this.plugin.settings.projects);
		await this.plugin.createTerminalLeaf(project, session.name);

		// Refresh to update hasPanel state
		setTimeout(() => { void this.refresh(); }, 500);
	}

	private async linkSessionNote(sessionName: string, project: string): Promise<void> {
		const config = this.plugin.settings.projects[project];
		if (!config) return;

		const dirPath = sessionDirPath(config.vaultFolder);
		const dir = this.app.vault.getAbstractFileByPath(dirPath);
		if (!dir || !(dir instanceof TFolder)) {
			new Notice("No sessions/ directory found for this project.");
			return;
		}

		const targetPath = sessionNotePath(config.vaultFolder, sessionName);
		const candidates = dir.children.filter(
			(f): f is TFile => f instanceof TFile && f.extension === "md" && f.path !== targetPath,
		);

		if (candidates.length === 0) {
			new Notice("No orphaned session notes found.");
			return;
		}

		new SessionNoteModal(this.app, candidates, (file) => {
			void this.app.vault.rename(file, targetPath).then(
				() => { void this.refresh(); },
				(err: unknown) => { new Notice(`Failed to link note: ${String(err)}`); },
			);
		}).open();
	}

	private showProjectForm(existingKey?: string) {
		if (!this.listEl) return;
		this.editing = true;

		const config = existingKey ? this.plugin.settings.projects[existingKey] : undefined;
		const isEdit = !!existingKey;

		// Remove any existing form
		this.listEl.querySelector(".co-sm-project-form")?.remove();

		const form = this.listEl.createDiv({ cls: "co-sm-project-form" });
		// Insert at top
		if (this.listEl.firstChild && this.listEl.firstChild !== form) {
			this.listEl.insertBefore(form, this.listEl.firstChild);
		}

		form.createDiv({ cls: "co-sm-form-title", text: isEdit ? `Edit: ${existingKey}` : "New Project" });

		const nameRow = form.createDiv({ cls: "co-sm-form-row" });
		nameRow.createSpan({ cls: "co-sm-form-label", text: "Name" });
		const nameInput = nameRow.createEl("input", { cls: "co-sm-form-input", type: "text" });
		if (isEdit) {
			nameInput.value = existingKey;
			nameInput.disabled = true;
		} else {
			nameInput.placeholder = "e.g. My Project";
		}

		const folderRow = form.createDiv({ cls: "co-sm-form-row" });
		folderRow.createSpan({ cls: "co-sm-form-label", text: "Note folder" });
		const folderInput = folderRow.createEl("input", { cls: "co-sm-form-input", type: "text" });
		folderInput.placeholder = "e.g. 01_Projects/MyProject";
		if (config) folderInput.value = config.vaultFolder;
		if (isEdit) {
			folderInput.disabled = true;
			folderInput.title = "Note folder cannot be changed after creation (session note paths would break)";
		}
		if (!isEdit) {
			const folderBrowseBtn = folderRow.createEl("button", { cls: "icon-btn co-sm-browse-btn" });
			setIcon(folderBrowseBtn, "folder");
			folderBrowseBtn.title = "Browse vault folders";
			folderBrowseBtn.addEventListener("click", () => {
				new VaultFolderModal(this.app, (folder) => {
					folderInput.value = folder.path;
				}).open();
			});
		}

		const cwdRow = form.createDiv({ cls: "co-sm-form-row" });
		cwdRow.createSpan({ cls: "co-sm-form-label", text: "Code folder" });
		const cwdInput = cwdRow.createEl("input", { cls: "co-sm-form-input", type: "text" });
		cwdInput.placeholder = "(optional)";
		if (config?.workingDirectory) cwdInput.value = config.workingDirectory;
		const cwdBrowseBtn = cwdRow.createEl("button", { cls: "icon-btn co-sm-browse-btn" });
		setIcon(cwdBrowseBtn, "folder");
		cwdBrowseBtn.title = "Browse filesystem folders";
		cwdBrowseBtn.addEventListener("click", () => void (async () => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Electron remote from require
			const electron = require("electron");
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- untyped Electron remote
			const dialog = electron.remote?.dialog;
			if (!dialog) return;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- untyped Electron API
			const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- untyped Electron result
			if (!result.canceled && result.filePaths?.[0]) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- untyped Electron result
				cwdInput.value = result.filePaths[0] as string;
			}
		})());

		const errorEl = form.createDiv({ cls: "co-sm-form-error" });
		errorEl.style.display = "none";

		const actions = form.createDiv({ cls: "co-sm-form-actions" });

		if (isEdit) {
			const rmBtn = actions.createEl("button", { cls: "btn", text: "Unregister" });
			rmBtn.dataset.tone = "danger";
			rmBtn.title = "Remove from project list. Session notes and tmux sessions are kept.";
			let rmConfirmPending = false;
			rmBtn.addEventListener("click", () => {
				if (!rmConfirmPending) {
					rmConfirmPending = true;
					rmBtn.textContent = "Confirm unregister?";
					setTimeout(() => {
						if (rmConfirmPending) {
							rmConfirmPending = false;
							rmBtn.textContent = "Unregister";
						}
					}, 3000);
					return;
				}
				this.plugin.settings.projects = removeProject(this.plugin.settings.projects, existingKey);
				void this.plugin.saveSettings();
				this.editing = false;
				void this.refresh();
			});
		}

		const cancelBtn = actions.createEl("button", { cls: "btn", text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			this.editing = false;
			void this.refresh();
		});

		const saveBtn = actions.createEl("button", { cls: "btn", text: "Save" });
		saveBtn.dataset.variant = "primary";
		saveBtn.addEventListener("click", () => {
			const key = nameInput.value.trim();
			const vaultFolder = normalizeVaultFolder(folderInput.value.trim());
			const workingDirectory = cwdInput.value.trim() || undefined;

			if (!isEdit) {
				if (key in this.plugin.settings.projects) {
					this.showProjectForm(key);
					return;
				}
				const err = validateProjectKey(key, new Set(Object.keys(this.plugin.settings.projects)));
				if (err) {
					errorEl.textContent = err;
					errorEl.style.display = "";
					return;
				}
			}

			const newConfig: ProjectConfig = { vaultFolder, workingDirectory };

			if (isEdit) {
				this.plugin.settings.projects = updateProjectConfig(this.plugin.settings.projects, existingKey, newConfig);
			} else {
				this.plugin.settings.projects = addProject(this.plugin.settings.projects, key, newConfig);
			}

			void this.plugin.saveSettings();
			this.editing = false;
			void this.refresh();
		});

		if (!isEdit) {
			nameInput.focus();
		} else {
			folderInput.focus();
		}
	}

	private closeSessionTab(sessionName: string) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.getSessionName() === sessionName) {
				leaf.detach();
				break;
			}
		}
		setTimeout(() => { void this.refresh(); }, 300);
	}

	private async killSession(sessionName: string, noteAction?: "archive" | "delete") {
		this.closeSessionTab(sessionName);
		await execTmux(["kill-session", "-t", sessionName]).catch(() => {});
		if (noteAction) {
			const project = projectFromSessionName(sessionName, this.plugin.settings.projects);
			if (project) {
				const config = this.plugin.settings.projects[project];
				if (config) {
					const notePath = sessionNotePath(config.vaultFolder, sessionName);
					const file = this.app.vault.getAbstractFileByPath(notePath);
					if (file instanceof TFile) {
						if (noteAction === "archive") {
							const archivePath = archiveSessionNotePath(config.vaultFolder, sessionName);
							await this.app.vault.rename(file, archivePath).catch(() => {});
						} else {
							await this.app.vault.delete(file).catch(() => {});
						}
					}
				}
			}
		}
		setTimeout(() => { void this.refresh(); }, 500);
	}
}

