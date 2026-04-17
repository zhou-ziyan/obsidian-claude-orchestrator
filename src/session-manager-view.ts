import { FuzzySuggestModal, ItemView, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import type { App } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";
import {
	tmuxLs,
	parseAllTmuxSessions,
	groupSessionsByProject,
	restorableSessionNames,
	sessionNotePath,
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
	SessionGroup,
	SessionInfo,
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

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("co-sm-container");

		// Header
		const header = container.createDiv({ cls: "co-sm-header" });
		header.createSpan({ cls: "co-sm-title", text: "Sessions" });
		const headerActions = header.createDiv({ cls: "co-sm-header-actions" });
		const refreshBtn = headerActions.createEl("button", {
			cls: "co-icon-btn",
			text: "↻",
		});
		refreshBtn.title = "Refresh";
		refreshBtn.addEventListener("click", () => { void this.refresh(); });

		const addBtn = headerActions.createEl("button", {
			cls: "co-icon-btn",
			text: "+",
		});
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

		// 3. Read session notes for managed sessions
		const noteData = new Map<string, {
			pinnedNote: string | null;
			queueCount: number;
			lastActivity: string | null;
			preview: string | null;
			notesSummary: string | null;
			displayName: string | null;
		}>();

		const projects = this.plugin.settings.projects;
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
				const firstLine = note.notes.split("\n")[0]?.trim() || null;
				noteData.set(s.name, {
					pinnedNote: note.pinnedNote,
					queueCount: note.queue.length,
					lastActivity,
					preview: extractSessionPreview(note),
					notesSummary: firstLine,
					displayName: note.displayName || null,
				});
			} catch {
				// Note read failed — skip
			}
		}

		// 4. Group
		this.groups = groupSessionsByProject(allSessions, openNames, noteData, projects);

		// 5. Render
		this.render();
	}

	private inactiveCollapsed = true;

	private render() {
		if (!this.listEl) return;
		this.listEl.empty();

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
		header.createSpan({
			cls: "co-sm-arrow",
			text: this.inactiveCollapsed ? "▸" : "▾",
		});
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
		label.textContent = `PTY ${used}/${max}`;

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
		groupHeader.createSpan({
			cls: "co-sm-arrow",
			text: collapsed ? "▸" : "▾",
		});
		groupHeader.createSpan({
			cls: "co-sm-group-name",
			text: group.project,
		});

		if (isManaged) {
			const restorable = restorableSessionNames(group);
			if (restorable.length > 0) {
				const restoreBtn = groupHeader.createEl("button", {
					cls: "co-icon-btn co-sm-gear",
					text: "⧉",
				});
				restoreBtn.title = `Restore ${restorable.length} session(s)`;
				restoreBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					void this.plugin.restoreProjectSessions(group.project).then(() => {
						setTimeout(() => { void this.refresh(); }, 500);
					});
				});
			}

			const newBtn = groupHeader.createEl("button", {
				cls: "co-icon-btn co-sm-gear",
				text: "+",
			});
			newBtn.title = "New session";
			newBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.plugin.createNewTerminalForProject(group.project).then(() => {
					setTimeout(() => { void this.refresh(); }, 500);
				});
			});

			const gearBtn = groupHeader.createEl("button", {
				cls: "co-icon-btn co-sm-gear",
				text: "⚙",
			});
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

		for (const session of group.sessions) {
			this.renderSessionCard(groupEl, session);
		}
	}

	private renderSessionCard(parent: HTMLElement, session: SessionInfo) {
		const isFocused = session.name === this.focusedSession;
		const idle = isSessionIdle(session.tmuxActivity);
		let cls = "co-sm-card";
		if (isFocused) cls += " co-sm-card-focused";
		if (idle) cls += " co-sm-card-idle";
		const card = parent.createDiv({ cls });
		if (isFocused) {
			requestAnimationFrame(() => card.scrollIntoView({ block: "nearest" }));
		}

		// Top row: name + kill button in top-right corner
		const topRow = card.createDiv({ cls: "co-sm-card-top" });

		const nameRow = topRow.createDiv({ cls: "co-sm-card-name" });
		nameRow.createSpan({
			cls: `co-sm-dot ${session.hasPanel ? "co-sm-dot-active" : ""}`,
			text: "●",
		});
		const displayLabel = session.displayName || session.name.replace(/-(\d+)$/, " #$1");
		const nameSpan = nameRow.createSpan({ text: displayLabel });
		nameSpan.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this.showInlineRename(nameSpan, session);
		});

		const killBtn = topRow.createEl("button", {
			cls: "co-icon-btn co-danger",
			text: "×",
		});
		killBtn.title = "Kill session";
		killBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.showKillConfirm(card, session.name);
		});

		// Pinned note (if any)
		if (session.pinnedNote) {
			const pinRow = card.createDiv({ cls: "co-sm-card-pin" });
			const noteName = session.pinnedNote.split("/").pop()?.replace(/\.md$/, "") ?? session.pinnedNote;
			pinRow.createSpan({ text: `📌 ${noteName}` });
		}

		// Notes summary
		if (session.notesSummary) {
			const notesRow = card.createDiv({ cls: "co-sm-card-notes" });
			notesRow.textContent = session.notesSummary;
		}

		// Info row: queue count + last activity + idle badge
		const infoRow = card.createDiv({ cls: "co-sm-card-info" });
		if (idle) {
			infoRow.createSpan({ cls: "co-sm-idle-badge", text: "\u23F3 idle" });
		}
		if (session.hasNote) {
			infoRow.createSpan({
				cls: "co-sm-badge",
				text: `Queue: ${session.queueCount}`,
			});
			if (session.lastActivity) {
				infoRow.createSpan({
					cls: "co-sm-time",
					text: formatRelativeTime(session.lastActivity),
				});
			}
		} else {
			infoRow.createSpan({
				cls: "co-sm-badge co-sm-unmanaged",
				text: "no session note",
			});
		}

		// Message preview
		if (session.preview) {
			const previewEl = card.createDiv({ cls: "co-sm-preview" });
			previewEl.textContent = session.preview;
		}

		card.addEventListener("dblclick", () => {
			if (session.hasPanel) {
				this.focusSession(session.name);
			} else {
				void this.attachSession(session);
			}
		});

		// Actions (bottom-left)
		const actions = card.createDiv({ cls: "co-sm-card-actions" });

		if (session.hasPanel && session.queueCount > 0) {
			const sendBtn = actions.createEl("button", {
				cls: "co-text-btn co-accent",
				text: "Send ▶",
			});
			sendBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.sendNextForSession(session.name);
			});
		}

	}

	private showInlineRename(nameSpan: HTMLElement, session: SessionInfo) {
		const current = session.displayName || "";
		const input = document.createElement("input");
		input.type = "text";
		input.value = current;
		input.placeholder = session.name.replace(/-(\d+)$/, " #$1");
		input.classList.add("co-sm-form-input", "co-sm-rename-input");
		nameSpan.replaceWith(input);
		input.focus();
		input.select();

		const save = () => {
			const newName = input.value.trim();
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
							note.displayName = newName;
							await this.app.vault.modify(file, serializeSessionNote(note));
							void this.refresh();
						})();
					}
				}
			}
		};

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); save(); }
			if (e.key === "Escape") { e.preventDefault(); void this.refresh(); }
		});
		input.addEventListener("blur", () => save());
	}

	private showKillConfirm(card: HTMLElement, sessionName: string) {
		// Remove any existing confirm portal
		card.querySelector(".co-sm-kill-portal")?.remove();

		const portal = card.createDiv({ cls: "co-sm-kill-portal" });
		portal.createSpan({
			cls: "co-sm-kill-msg",
			text: `Kill "${sessionName}"? This will terminate all processes.`,
		});
		const portalActions = portal.createDiv({ cls: "co-sm-kill-portal-actions" });

		const cancelBtn = portalActions.createEl("button", {
			cls: "co-text-btn",
			text: "Cancel",
		});
		cancelBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			portal.remove();
		});

		const closeTabBtn = portalActions.createEl("button", {
			cls: "co-text-btn",
			text: "Close tab",
		});
		closeTabBtn.title = "Close terminal tab but keep tmux session running";
		closeTabBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			portal.remove();
			void this.closeSessionTab(sessionName);
		});

		const confirmBtn = portalActions.createEl("button", {
			cls: "co-text-btn co-sm-kill-confirm",
			text: "Kill session",
		});
		confirmBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			portal.remove();
			void this.killSession(sessionName);
		});

		// Auto-dismiss after 8 seconds
		setTimeout(() => portal.remove(), 8000);
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
		const { workspace } = this.app;

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({
			type: VIEW_TYPE_TERMINAL,
			active: true,
		});

		const view = leaf.view;
		if (view instanceof TerminalView) {
			view.setProject(project, session.name);
		}
		void workspace.revealLeaf(leaf);

		// Refresh to update hasPanel state
		setTimeout(() => { void this.refresh(); }, 500);
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
			const folderBrowseBtn = folderRow.createEl("button", { cls: "co-icon-btn co-sm-browse-btn", text: "📂" });
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
		const cwdBrowseBtn = cwdRow.createEl("button", { cls: "co-icon-btn co-sm-browse-btn", text: "📂" });
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
			const rmBtn = actions.createEl("button", { cls: "co-text-btn co-danger", text: "Remove" });
			rmBtn.addEventListener("click", () => {
				this.plugin.settings.projects = removeProject(this.plugin.settings.projects, existingKey);
				void this.plugin.saveSettings();
				this.editing = false;
				void this.refresh();
			});
		}

		const cancelBtn = actions.createEl("button", { cls: "co-text-btn", text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			this.editing = false;
			void this.refresh();
		});

		const saveBtn = actions.createEl("button", { cls: "co-text-btn co-accent", text: "Save" });
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

	private async killSession(sessionName: string) {
		await execTmux(["kill-session", "-t", sessionName]).catch(() => {});
		setTimeout(() => { void this.refresh(); }, 500);
	}
}

