import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";
import { SessionManagerView, VIEW_TYPE_SESSION_MANAGER } from "./session-manager-view";
import { generateSessionName, migrateSettings, parseTmuxSessionsForProject, resolveProjectFromPath, tmuxLs, fetchPtyUsage, getPtyStatus, ptyStatusMessage } from "./utils";
import type { ProjectRegistry } from "./utils";
import { StopHookWatcher } from "./stop-hook-watcher";

export interface OrchestratorSettings {
	simpleMode: boolean;
	projects: ProjectRegistry;
}

const DEFAULT_SETTINGS: OrchestratorSettings = {
	simpleMode: false,
	projects: {},
};

export default class ClaudeOrchestratorPlugin extends Plugin {
	settings: OrchestratorSettings = DEFAULT_SETTINGS;
	private stopHookWatcher: StopHookWatcher | null = null;

	async onload() {
		await this.loadSettings();
		await this.autoDiscoverProjects();

		const pluginDir = this.resolvePluginDir();

		this.registerView(
			VIEW_TYPE_TERMINAL,
			(leaf) =>
				new TerminalView(
					leaf,
					pluginDir,
					(project, sessionName) => {
						void this.onTerminalFocus(project, sessionName);
					},
					() => this.settings,
				),
		);

		this.addCommand({
			id: "open-terminal",
			name: "Open terminal for current project",
			callback: () => this.openTerminal(),
		});

		this.addCommand({
			id: "restore-all-terminals",
			name: "Restore all terminals for current project",
			callback: () => this.restoreAllTerminals(),
		});

		this.addCommand({
			id: "create-new-terminal",
			name: "Create new terminal for current project",
			callback: () => this.createNewTerminal(),
		});

		this.addCommand({
			id: "switch-to-simple-mode",
			name: "Switch to simple mode (terminal only)",
			checkCallback: (checking) => {
				if (this.settings.simpleMode) return false;
				if (!checking) {
					this.settings.simpleMode = true;
					void this.saveSettings();
					new Notice("Simple mode — reload plugin to apply");
				}
				return true;
			},
		});

		this.addCommand({
			id: "switch-to-full-mode",
			name: "Switch to full mode (queue & history)",
			checkCallback: (checking) => {
				if (!this.settings.simpleMode) return false;
				if (!checking) {
					this.settings.simpleMode = false;
					void this.saveSettings();
					new Notice("Full mode — reload plugin to apply");
				}
				return true;
			},
		});

		// --- Session Manager ---
		this.registerView(
			VIEW_TYPE_SESSION_MANAGER,
			(leaf) => new SessionManagerView(leaf, this),
		);

		this.addCommand({
			id: "open-session-manager",
			name: "Open session manager",
			callback: () => this.openSessionManager(),
		});

		this.addRibbonIcon("terminal", "Open terminal for current project", () => {
			void this.openTerminal();
		});

		// Also handle tab switches (clicking the tab header doesn't
		// trigger focusin on the terminal host, so we listen here).
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!leaf) return;
				const view = leaf.view;
				if (view instanceof TerminalView) {
					// Auto-focus the terminal so the user can type immediately
					view.focusTerminal();
					const project = view.getProject();
					const sessionName = view.getSessionName();
					if (project && sessionName) {
						void this.onTerminalFocus(project, sessionName);
					}
					this.highlightSessionInManager(view.getSessionName());
				} else {
					this.highlightSessionInManager(null);
				}
			}),
		);

		this.addSettingTab(new OrchestratorSettingTab(this.app, this));

		// Auto-open Session Manager in left sidebar on startup
		this.app.workspace.onLayoutReady(() => {
			if (this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION_MANAGER).length === 0) {
				void this.openSessionManager();
			}
		});

		// Stop hook watcher
		this.stopHookWatcher = new StopHookWatcher(() => this.settings.projects);
		this.stopHookWatcher.onSignal((signal, project) => {
			new Notice(`Claude stopped in ${project} (${signal.tmuxSession})`);
			this.refreshSessionManager();
		});
		this.stopHookWatcher.start();
	}

	onunload() {
		this.stopHookWatcher?.stop();
	}

	async loadSettings() {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Obsidian loadData() returns any
		const raw: Record<string, unknown> = await this.loadData() ?? {};
		const data = migrateSettings(raw);
		this.settings = { ...DEFAULT_SETTINGS, ...data as Partial<OrchestratorSettings> };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async onTerminalFocus(_project: string, sessionName: string) {
		// Only jump if this session has an explicitly pinned note.
		// No pin → do nothing.
		let pinnedPath: string | null = null;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.getSessionName() === sessionName) {
				pinnedPath = view.getPinnedNote();
				break;
			}
		}

		if (!pinnedPath) return;

		const file = this.app.vault.getAbstractFileByPath(pinnedPath);
		if (!(file instanceof TFile)) return;

		// Find a markdown leaf in the main area (skip terminal views).
		let targetLeaf = null;
		const allLeaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of allLeaves) {
			if (leaf.getRoot() === this.app.workspace.rootSplit) {
				targetLeaf = leaf;
				break;
			}
		}
		// No markdown leaf in main area — create a new tab there.
		if (!targetLeaf) {
			targetLeaf = this.app.workspace.getLeaf("tab");
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- MarkdownView.file not in public typings
		const currentFile = (targetLeaf.view as any)?.file as TFile | undefined;
		if (currentFile?.path === file.path) return;

		await targetLeaf.openFile(file, { active: false });
	}

	private collectSessionNames(): Set<string> {
		const names = new Set<string>();
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TERMINAL,
		)) {
			const view = leaf.view;
			if (view instanceof TerminalView) {
				const name = view.getSessionName();
				if (name) names.add(name);
			}
		}
		return names;
	}

	// --- "Open terminal for current project" ---
	// 1. If any terminal tabs already open for this project → reveal the first one.
	// 2. Else check tmux for alive sessions → restore all of them.
	// 3. Else create a fresh terminal.
	async openTerminal() {
		const { workspace } = this.app;
		const project = this.resolveActiveProject();

		// Already have open tabs? Reveal the first one.
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.getProject() === project) {
				void workspace.revealLeaf(leaf);
				view.focusTerminal();
				return;
			}
		}

		if (!project) {
			// No project context — just open a plain shell.
			await this.createTerminalLeaf(null, null);
			return;
		}

		// No open tabs — try to restore all alive tmux sessions.
		const openSessionNames = this.collectSessionNames();
		const tmuxOutput = await tmuxLs();
		const { names: aliveSessions, mostRecent } =
			parseTmuxSessionsForProject(tmuxOutput, project);

		const missing = aliveSessions.filter((s) => !openSessionNames.has(s));

		if (missing.length > 0) {
			for (const sessionName of missing) {
				await this.createTerminalLeaf(project, sessionName);
			}
			// Reveal the most recently active session
			if (mostRecent && missing.includes(mostRecent)) {
				for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
					const view = leaf.view;
					if (view instanceof TerminalView && view.getSessionName() === mostRecent) {
						void workspace.revealLeaf(leaf);
						break;
					}
				}
			}
			return;
		}

		// No alive sessions either — create fresh.
		await this.createTerminalLeaf(project, project);
	}

	// --- "Restore all terminals for current project" ---
	// Checks `tmux ls` and opens a tab for every alive session that
	// doesn't already have one.
	async restoreAllTerminals() {
		const project = this.resolveActiveProject();
		if (!project) {
			new Notice("No project context — open a project note first.");
			return;
		}
		const count = await this.restoreProjectSessions(project);
		if (count === 0) {
			new Notice("All sessions for this project are already open.");
		}
	}

	async restoreProjectSessions(project: string): Promise<number> {
		const openSessionNames = this.collectSessionNames();
		const tmuxOutput = await tmuxLs();
		const { names: aliveSessions, mostRecent } =
			parseTmuxSessionsForProject(tmuxOutput, project);

		if (aliveSessions.length === 0) {
			new Notice(
				`No alive tmux sessions found for ${project}. Use "Create new terminal" instead.`,
			);
			return 0;
		}

		const missing = aliveSessions.filter((s) => !openSessionNames.has(s));

		if (missing.length === 0) {
			return 0;
		}

		for (const sessionName of missing) {
			await this.createTerminalLeaf(project, sessionName);
		}

		if (mostRecent && missing.includes(mostRecent)) {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
				const view = leaf.view;
				if (view instanceof TerminalView && view.getSessionName() === mostRecent) {
					void this.app.workspace.revealLeaf(leaf);
					break;
				}
			}
		}
		new Notice(`Restored ${missing.length} terminal(s).`);
		return missing.length;
	}

	// --- "Create new terminal for current project" ---
	// Always creates a fresh tmux session with the next available name.
	async createNewTerminal() {
		const project = this.resolveActiveProject();
		if (!project) {
			new Notice("No project context — open a project note first.");
			return;
		}

		const sessionName = generateSessionName(
			project,
			this.collectSessionNames(),
		);
		await this.createTerminalLeaf(project, sessionName);
	}

	// --- "Open session manager" ---
	async openSessionManager() {
		const { workspace } = this.app;

		// Reveal if already open.
		const existing = workspace.getLeavesOfType(VIEW_TYPE_SESSION_MANAGER);
		if (existing[0]) {
			void workspace.revealLeaf(existing[0]);
			return;
		}

		// Open in the left sidebar (below file explorer).
		const leaf = workspace.getLeftLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({
			type: VIEW_TYPE_SESSION_MANAGER,
			active: true,
		});
		void workspace.revealLeaf(leaf);
	}

	private highlightSessionInManager(sessionName: string | null) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION_MANAGER)) {
			const view = leaf.view;
			if (view instanceof SessionManagerView) {
				view.highlightSession(sessionName);
			}
		}
	}

	private refreshSessionManager() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION_MANAGER)) {
			const view = leaf.view;
			if (view instanceof SessionManagerView) {
				void view.refresh();
			}
		}
	}

	// --- Shared helpers ---

	private async createTerminalLeaf(
		project: string | null,
		sessionName: string | null,
	): Promise<void> {
		const usage = await fetchPtyUsage();
		const ptyStatus = getPtyStatus(usage);
		if (ptyStatus === "exhausted") {
			new Notice(ptyStatusMessage(usage, ptyStatus));
			return;
		}
		if (ptyStatus === "warning") {
			new Notice(ptyStatusMessage(usage, ptyStatus));
		}

		const { workspace } = this.app;

		// Find existing terminals to decide placement.
		const terminals = workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);

		let leaf;
		// Check if any existing terminal belongs to the same project.
		const sameProject = terminals.find((l) => {
			const v = l.view;
			return v instanceof TerminalView && v.getProject() === project;
		});

		if (sameProject) {
			// Same project → new tab in the same tab group.
			workspace.setActiveLeaf(sameProject, { focus: false });
			leaf = workspace.getLeaf("tab");
		} else if (terminals.length > 0) {
			// Different project → vertical split next to the last terminal group.
			// This creates: [editor] [projectA tabs] [projectB tabs]
			const lastTerminal = terminals[terminals.length - 1]!;
			leaf = workspace.createLeafBySplit(lastTerminal, "vertical");
		} else {
			// No terminals at all → split the main editor to the right.
			const mainLeaf = workspace.getMostRecentLeaf(workspace.rootSplit);
			if (mainLeaf) {
				leaf = workspace.createLeafBySplit(mainLeaf, "vertical");
			} else {
				leaf = workspace.getLeaf("split");
			}
		}

		await leaf.setViewState({
			type: VIEW_TYPE_TERMINAL,
			active: true,
		});

		const view = leaf.view;
		if (view instanceof TerminalView) {
			view.setProject(project, sessionName ?? undefined);
		}
		void workspace.revealLeaf(leaf);
	}

	private resolveActiveProject(): string | null {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return null;
		return resolveProjectFromPath(activeFile.path, this.settings.projects);
	}

	private async autoDiscoverProjects(): Promise<void> {
		if (Object.keys(this.settings.projects).length > 0) return;
		const folder = this.app.vault.getAbstractFileByPath("01_Projects");
		if (!(folder instanceof TFolder)) return;
		for (const child of folder.children) {
			if (child instanceof TFolder && /^\d+_/.test(child.name)) {
				this.settings.projects[child.name] = {
					vaultFolder: child.path,
				};
			}
		}
		if (Object.keys(this.settings.projects).length > 0) {
			await this.saveSettings();
		}
	}

	private resolvePluginDir(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error(
				"Claude Orchestrator requires a local vault (FileSystemAdapter).",
			);
		}
		if (!this.manifest.dir) {
			throw new Error("Plugin manifest has no dir.");
		}
		return adapter.getFullPath(this.manifest.dir);
	}
}

class OrchestratorSettingTab extends PluginSettingTab {
	plugin: ClaudeOrchestratorPlugin;

	constructor(app: App, plugin: ClaudeOrchestratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Simple mode")
			.setDesc(
				"Hide queue and history panels. Terminal only.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.simpleMode)
					.onChange(async (value) => {
						this.plugin.settings.simpleMode = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
