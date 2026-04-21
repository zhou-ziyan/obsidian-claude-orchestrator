import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";
import { SessionManagerView, VIEW_TYPE_SESSION_MANAGER } from "./session-manager-view";
import { generateSessionName, collectNoteNamesFromFiles, migrateSettings, parseTmuxSessionsForProject, resolveProjectFromPath, tmuxLs, fetchPtyUsage, getPtyStatus, ptyStatusMessage, sessionNotePath, sessionDirPath, parseSessionNote, serializeSessionNote, ensureStopHookConfig, QUICK_REPLY_KEYS, parseQuickReplyKeys, loadSlashCommands, BUILTIN_SLASH_COMMANDS, migrateThemeName } from "./utils";
import type { ProjectRegistry, QueueMode, SlashCommandEntry, ThemeName } from "./utils";
import { QUEUE_MODES, queueModeLabel } from "./utils";
import { StopHookWatcher } from "./stop-hook-watcher";
import { findTerminalLeafBySession, findTerminalLeafByProject, collectOpenSessionNames } from "./workspace-helpers";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface OrchestratorSettings {
	simpleMode: boolean;
	projects: ProjectRegistry;
	quickReplyKeys: string[];
	sessionOrder: Record<string, string[]>;
	playSoundOnAsking: boolean;
	theme: ThemeName;
	defaultQueueMode: QueueMode;
}

const DEFAULT_SETTINGS: OrchestratorSettings = {
	simpleMode: false,
	projects: {},
	quickReplyKeys: [...QUICK_REPLY_KEYS],
	sessionOrder: {},
	playSoundOnAsking: true,
	theme: "obsidian",
	defaultQueueMode: "manual",
};

export default class ClaudeOrchestratorPlugin extends Plugin {
	settings: OrchestratorSettings = DEFAULT_SETTINGS;
	private slashCommands: SlashCommandEntry[] = [...BUILTIN_SLASH_COMMANDS];
	private stopHookWatcher: StopHookWatcher | null = null;

	async onload() {
		await this.loadSettings();
		await this.autoDiscoverProjects();

		const pluginDir = this.resolvePluginDir();
		this.ensureStopHookRegistered(pluginDir);

		this.registerView(
			VIEW_TYPE_TERMINAL,
			(leaf) =>
				new TerminalView(
					leaf,
					pluginDir,
					() => ({ ...this.settings, slashCommands: this.slashCommands }),
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
					view.focusTerminal();
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

		// Load dynamic slash commands
		this.loadSlashCommands();

		// Stop hook watcher
		this.stopHookWatcher = new StopHookWatcher(() => this.settings.projects);
		this.stopHookWatcher.onSignal((signal, project) => {
			const reason = signal.stopReason ?? "done";
			const routed = this.routeStopSignalToView(signal.tmuxSession, reason);
			if (!routed) {
				void this.updateSessionStatus(project, signal.tmuxSession, reason);
			}
			this.refreshSessionManager();
		});
		this.stopHookWatcher.start();
	}

	onunload() {
		this.stopHookWatcher?.stop();
	}

	private loadSlashCommands(): void {
		const skillDirs = [join(homedir(), ".claude", "skills")];
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			skillDirs.push(join(adapter.getBasePath(), ".claude", "skills"));
		}
		for (const config of Object.values(this.settings.projects)) {
			if (config.workingDirectory) {
				skillDirs.push(join(config.workingDirectory, ".claude", "skills"));
			}
		}
		this.slashCommands = loadSlashCommands(skillDirs);
	}

	async loadSettings() {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Obsidian loadData() returns any
		const raw: Record<string, unknown> = await this.loadData() ?? {};
		const data = migrateSettings(raw);
		this.settings = { ...DEFAULT_SETTINGS, ...data as Partial<OrchestratorSettings> };
		this.settings.theme = migrateThemeName(this.settings.theme);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	applyThemeToAllViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView) {
				view.applyTheme(this.settings.theme);
			}
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION_MANAGER)) {
			const view = leaf.view;
			if (view instanceof SessionManagerView) {
				view.applyTheme(this.settings.theme);
			}
		}
	}

	private collectSessionNames(): Set<string> {
		return collectOpenSessionNames(this.app.workspace);
	}

	// --- "Open terminal for current project" ---
	// 1. If any terminal tabs already open for this project → reveal the first one.
	// 2. Else check tmux for alive sessions → restore all of them.
	// 3. Else create a fresh terminal.
	async openTerminal() {
		const { workspace } = this.app;
		const project = this.resolveActiveProject();

		// Already have open tabs? Reveal the first one.
		if (project) {
			const existing = findTerminalLeafByProject(workspace, project);
			if (existing) {
				void workspace.revealLeaf(existing.leaf);
				existing.view.focusTerminal();
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
			if (mostRecent && missing.includes(mostRecent)) {
				const recent = findTerminalLeafBySession(workspace, mostRecent);
				if (recent) void workspace.revealLeaf(recent.leaf);
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
			const recent = findTerminalLeafBySession(this.app.workspace, mostRecent);
			if (recent) void this.app.workspace.revealLeaf(recent.leaf);
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
		await this.createNewTerminalForProject(project);
	}

	async createNewTerminalForProject(project: string) {
		const openNames = this.collectSessionNames();
		const config = this.settings.projects[project];
		if (config) {
			const dir = sessionDirPath(config.vaultFolder);
			const folder = this.app.vault.getAbstractFileByPath(dir);
			if (folder instanceof TFolder) {
				const fileNames = folder.children
					.filter((c): c is TFile => c instanceof TFile)
					.map((f) => f.name);
				for (const n of collectNoteNamesFromFiles(fileNames)) {
					openNames.add(n);
				}
			}
		}
		const sessionName = generateSessionName(project, openNames);
		await this.createTerminalLeaf(project, sessionName);
	}

	async gatherProjectTerminals(project: string): Promise<void> {
		const { workspace } = this.app;
		const leaves: { leaf: import("obsidian").WorkspaceLeaf; sessionName: string | null }[] = [];
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.getProject() === project) {
				leaves.push({ leaf, sessionName: view.getSessionName() });
			}
		}
		if (leaves.length <= 1) return;

		const anchor = leaves[0]!.leaf;
		const scattered = leaves.filter((l) => l.leaf.parent !== anchor.parent);
		if (scattered.length === 0) return;

		for (const { leaf, sessionName } of scattered) {
			leaf.detach();
			workspace.setActiveLeaf(anchor, { focus: false });
			const newLeaf = workspace.getLeaf("tab");
			await newLeaf.setViewState({
				type: VIEW_TYPE_TERMINAL,
				active: false,
				state: { project, sessionName },
			});
		}
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

	private async updateSessionStatus(project: string, sessionName: string, reason: "done" | "asking"): Promise<void> {
		const config = this.settings.projects[project];
		if (!config) return;
		const notePath = sessionNotePath(config.vaultFolder, sessionName);
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!file || !(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);
		const note = parseSessionNote(content, sessionName);
		note.status = reason === "asking" ? "waiting_for_user" : "idle";
		await this.app.vault.modify(file, serializeSessionNote(note));
	}

	private refreshSessionManager() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION_MANAGER)) {
			const view = leaf.view;
			if (view instanceof SessionManagerView) {
				void view.refresh();
			}
		}
	}

	private routeStopSignalToView(tmuxSession: string, reason: "done" | "asking"): boolean {
		const match = findTerminalLeafBySession(this.app.workspace, tmuxSession);
		if (match) {
			match.view.onStopSignal(reason);
			return true;
		}
		return false;
	}

	// --- Shared helpers ---

	async createTerminalLeaf(
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

		// Only consider terminals in the center workspace, not sidebar leftovers.
		const terminals = workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)
			.filter(l => l.getRoot() === workspace.rootSplit);

		let leaf;
		const sameProject = project
			? terminals.find(l => l.view instanceof TerminalView && l.view.getProject() === project)
			: null;

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
			// No terminals at all → reuse empty tab or split the editor.
			const mainLeaf = workspace.getMostRecentLeaf(workspace.rootSplit);
			if (mainLeaf && mainLeaf.view.getViewType() === "empty") {
				leaf = mainLeaf;
			} else if (mainLeaf) {
				leaf = workspace.createLeafBySplit(mainLeaf, "vertical");
			} else {
				leaf = workspace.getLeaf("split");
			}
		}

		await leaf.setViewState({
			type: VIEW_TYPE_TERMINAL,
			active: true,
			state: { project, sessionName },
		});

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

	private ensureStopHookRegistered(pluginDir: string): void {
		const scriptPath = join(pluginDir, "scripts", "co-stop-hook.sh");
		const settingsPath = join(homedir(), ".claude", "settings.json");
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const result = ensureStopHookConfig(content, scriptPath);
			if (result.updated) {
				writeFileSync(settingsPath, result.content, "utf-8");
			}
		} catch {
			// Settings file doesn't exist or isn't readable — skip
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

		new Setting(containerEl)
			.setName("Quick reply keys")
			.setDesc("Comma-separated list. Plain text sends literally. {C-c} sends Ctrl+C, {C-d} sends Ctrl+D.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.quickReplyKeys.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.quickReplyKeys = parseQuickReplyKeys(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Play sound when asking")
			.setDesc("Play a chime when Claude stops and is waiting for your input.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playSoundOnAsking)
					.onChange(async (value) => {
						this.plugin.settings.playSoundOnAsking = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Default queue mode")
			.setDesc("Queue mode for newly created sessions.")
			.addDropdown((dropdown) => {
				for (const m of QUEUE_MODES) {
					dropdown.addOption(m, queueModeLabel(m));
				}
				dropdown
					.setValue(this.plugin.settings.defaultQueueMode)
					.onChange(async (value) => {
						this.plugin.settings.defaultQueueMode = value as QueueMode;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Theme")
			.setDesc("Visual theme for the plugin UI.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("terminal", "Terminal")
					.addOption("obsidian", "Obsidian")
					.setValue(this.plugin.settings.theme)
					.onChange(async (value) => {
						this.plugin.settings.theme = value as ThemeName;
						await this.plugin.saveSettings();
						this.plugin.applyThemeToAllViews();
					}),
			);
	}
}
