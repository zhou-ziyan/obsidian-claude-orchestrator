import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";
import {
	tmuxLs,
	parseAllTmuxSessions,
	groupSessionsByProject,
	sessionNotePath,
	parseSessionNote,
	projectFromSessionName,
	formatRelativeTime,
	validateProjectKey,
	addProject,
	updateProjectConfig,
	removeProject,
	normalizeVaultFolder,
	SessionGroup,
	SessionInfo,
} from "./utils";
import type { ProjectConfig } from "./utils";
import type ClaudeOrchestratorPlugin from "./main";

export const VIEW_TYPE_SESSION_MANAGER = "claude-orchestrator-session-manager";

const POLL_INTERVAL_MS = 30_000;

// Timestamp pattern used in queue/history items: [YYYY-MM-DD HH:MM]
const TIMESTAMP_RE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/;

export class SessionManagerView extends ItemView {
	private plugin: ClaudeOrchestratorPlugin;
	private groups: SessionGroup[] = [];
	private listEl: HTMLElement | null = null;
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
		const refreshBtn = header.createEl("button", {
			cls: "co-icon-btn",
			text: "↻",
		});
		refreshBtn.title = "Refresh";
		refreshBtn.addEventListener("click", () => { void this.refresh(); });

		const addBtn = header.createEl("button", {
			cls: "co-icon-btn",
			text: "+",
		});
		addBtn.title = "Add project";
		addBtn.addEventListener("click", () => { this.showProjectForm(); });

		// Session list
		this.listEl = container.createDiv({ cls: "co-sm-list" });

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

		// 1. Get all tmux sessions
		const tmuxOutput = await tmuxLs();
		const allSessions = parseAllTmuxSessions(tmuxOutput);

		// 2. Collect open terminal panel session names
		const openNames = new Set<string>();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView) {
				const name = view.getSessionName();
				if (name) openNames.add(name);
			}
		}

		// 3. Read session notes for managed sessions
		const noteData = new Map<string, {
			pinnedNote: string | null;
			queueCount: number;
			lastActivity: string | null;
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
				noteData.set(s.name, {
					pinnedNote: note.pinnedNote,
					queueCount: note.queue.length,
					lastActivity,
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

	private render() {
		if (!this.listEl) return;
		this.listEl.empty();

		const activeProjectNames = new Set(this.groups.map((g) => g.project));

		if (this.groups.length === 0 && Object.keys(this.plugin.settings.projects).length === 0) {
			this.listEl.createDiv({
				cls: "co-sm-empty",
				text: "No projects registered. Click + to add one.",
			});
			return;
		}

		for (const group of this.groups) {
			this.renderGroup(group);
		}

		for (const [key, config] of Object.entries(this.plugin.settings.projects)) {
			if (!activeProjectNames.has(key)) {
				this.renderIdleProject(key, config);
			}
		}
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
		groupHeader.createSpan({
			cls: "co-sm-group-count",
			text: `${group.sessions.length}`,
		});

		if (isManaged) {
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

		groupHeader.addEventListener("click", () => {
			if (this.collapsedProjects.has(group.project)) {
				this.collapsedProjects.delete(group.project);
			} else {
				this.collapsedProjects.add(group.project);
			}
			this.render();
		});

		if (collapsed) return;

		// Session cards
		for (const session of group.sessions) {
			this.renderSessionCard(groupEl, session);
		}
	}

	private renderIdleProject(key: string, _config: ProjectConfig) {
		if (!this.listEl) return;
		const groupEl = this.listEl.createDiv({ cls: "co-sm-group" });
		const groupHeader = groupEl.createDiv({ cls: "co-sm-group-header" });
		groupHeader.createSpan({ cls: "co-sm-arrow", text: "▸" });
		groupHeader.createSpan({ cls: "co-sm-group-name co-sm-idle", text: key });
		groupHeader.createSpan({ cls: "co-sm-group-count", text: "0" });

		const gearBtn = groupHeader.createEl("button", {
			cls: "co-icon-btn co-sm-gear",
			text: "⚙",
		});
		gearBtn.title = "Edit project";
		gearBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.showProjectForm(key);
		});
	}

	private renderSessionCard(parent: HTMLElement, session: SessionInfo) {
		const isFocused = session.name === this.focusedSession;
		const card = parent.createDiv({ cls: `co-sm-card${isFocused ? " co-sm-card-focused" : ""}` });
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
		nameRow.createSpan({ text: session.name.replace(/-(\d+)$/, " #$1") });

		// Kill × in top-right, far from action buttons
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

		// Info row: queue count + last activity
		const infoRow = card.createDiv({ cls: "co-sm-card-info" });
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

		card.addEventListener("dblclick", () => {
			if (session.hasPanel) {
				this.focusSession(session.name);
			} else {
				void this.attachSession(session);
			}
		});

		// Actions (bottom-left)
		const actions = card.createDiv({ cls: "co-sm-card-actions" });

		if (session.hasPanel) {
			const focusBtn = actions.createEl("button", {
				cls: "co-text-btn",
				text: "Focus",
			});
			focusBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.focusSession(session.name);
			});

			if (session.queueCount > 0) {
				const sendBtn = actions.createEl("button", {
					cls: "co-text-btn co-accent",
					text: "Send ▶",
				});
				sendBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					void this.sendNextForSession(session.name);
				});
			}
		} else {
			const attachBtn = actions.createEl("button", {
				cls: "co-text-btn",
				text: "Attach",
			});
			attachBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.attachSession(session);
			});
		}
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
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.getSessionName() === sessionName) {
				void this.app.workspace.revealLeaf(leaf);
				view.focusTerminal();
				return;
			}
		}
	}

	private async sendNextForSession(sessionName: string) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.getSessionName() === sessionName) {
				await view.sendNext();
				// Refresh to update queue count
				setTimeout(() => { void this.refresh(); }, 300);
				return;
			}
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
		folderRow.createSpan({ cls: "co-sm-form-label", text: "Vault folder" });
		const folderInput = folderRow.createEl("input", { cls: "co-sm-form-input", type: "text" });
		folderInput.placeholder = "e.g. 01_Projects/MyProject";
		if (config) folderInput.value = config.vaultFolder;

		const cwdRow = form.createDiv({ cls: "co-sm-form-row" });
		cwdRow.createSpan({ cls: "co-sm-form-label", text: "Working dir" });
		const cwdInput = cwdRow.createEl("input", { cls: "co-sm-form-input", type: "text" });
		cwdInput.placeholder = "(optional)";
		if (config?.workingDirectory) cwdInput.value = config.workingDirectory;

		const linkedRow = form.createDiv({ cls: "co-sm-form-row" });
		linkedRow.createSpan({ cls: "co-sm-form-label", text: "Linked file" });
		const linkedInput = linkedRow.createEl("input", { cls: "co-sm-form-input", type: "text" });
		linkedInput.placeholder = "(optional — e.g. CLAUDE.md)";
		if (config?.linkedFile) linkedInput.value = config.linkedFile;

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
			const linkedFile = linkedInput.value.trim() || undefined;

			if (!isEdit) {
				const err = validateProjectKey(key, new Set(Object.keys(this.plugin.settings.projects)));
				if (err) {
					errorEl.textContent = err;
					errorEl.style.display = "";
					return;
				}
			}

			const newConfig: ProjectConfig = { vaultFolder, workingDirectory, linkedFile };

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

	private async killSession(sessionName: string) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- child_process from require
		const { execFile } = require("child_process");
		const prependPath = ["/opt/homebrew/bin", "/usr/local/bin"];
		const existingPath = process.env.PATH || "/usr/bin:/bin";
		const entries = existingPath.split(":");
		for (const p of prependPath) {
			if (!entries.includes(p)) entries.unshift(p);
		}

		await new Promise<void>((resolve) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-call -- execFile is untyped from require
			execFile(
				"tmux",
				["kill-session", "-t", sessionName],
				{ env: { ...process.env, PATH: entries.join(":") } },
				() => resolve(),
			);
		});

		// Refresh to reflect the killed session
		setTimeout(() => { void this.refresh(); }, 500);
	}
}

