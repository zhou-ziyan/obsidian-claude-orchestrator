import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";
import { PROJECTS_DIR, PROJECT_PATH_RE, generateSessionName, parseTmuxSessionsForProject } from "./utils";
import { execFile } from "child_process";

interface OrchestratorSettings {
	autoRevealNote: boolean;
	queuePanel: boolean;
}

const DEFAULT_SETTINGS: OrchestratorSettings = {
	autoRevealNote: true,
	queuePanel: false,
};

export default class ClaudeOrchestratorPlugin extends Plugin {
	settings: OrchestratorSettings = DEFAULT_SETTINGS;
	private lastNoteByProject = new Map<string, string>();

	async onload() {
		await this.loadSettings();

		const pluginDir = this.resolvePluginDir();

		this.registerView(
			VIEW_TYPE_TERMINAL,
			(leaf) =>
				new TerminalView(
					leaf,
					pluginDir,
					(project) => this.onTerminalFocus(project),
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
			id: "toggle-auto-reveal",
			name: "Toggle auto-reveal note on terminal focus",
			callback: async () => {
				this.settings.autoRevealNote = !this.settings.autoRevealNote;
				await this.saveSettings();
				new Notice(
					`Auto-reveal note: ${this.settings.autoRevealNote ? "on" : "off"}`,
				);
			},
		});

		this.addRibbonIcon("terminal", "Open terminal for current project", () => {
			this.activateView();
		});

		// Track last-opened note per project
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return;
				const match = file.path.match(PROJECT_PATH_RE);
				if (match) {
					this.lastNoteByProject.set(match[1], file.path);
				}
			}),
		);

		this.addSettingTab(new OrchestratorSettingTab(this.app, this));
	}

	async onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async onTerminalFocus(project: string) {
		if (!this.settings.autoRevealNote) return;

		const lastPath = this.lastNoteByProject.get(project);
		const fallbackPath = `${PROJECTS_DIR}/${project}/${project}.md`;

		let file = lastPath
			? this.app.vault.getAbstractFileByPath(lastPath)
			: null;
		if (!(file instanceof TFile)) {
			file = this.app.vault.getAbstractFileByPath(fallbackPath);
		}
		if (!(file instanceof TFile)) return;

		const mainLeaf = this.app.workspace.getMostRecentLeaf(
			this.app.workspace.rootSplit,
		);
		if (mainLeaf) {
			await mainLeaf.openFile(file, { active: false });
		}
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
	// Reveals an existing terminal tab for this project, or creates one
	// (attaching to an alive tmux session if available).
	async openTerminal() {
		const { workspace } = this.app;
		const project = this.resolveActiveProject();

		// Reveal existing terminal for this project.
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.getProject() === project) {
				workspace.revealLeaf(leaf);
				return;
			}
		}

		// None open — create one (tmux -A will reattach if session exists).
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

		const openSessionNames = this.collectSessionNames();
		const tmuxOutput = await this.tmuxLs();
		const aliveSessions = parseTmuxSessionsForProject(
			tmuxOutput,
			project,
		);

		if (aliveSessions.length === 0) {
			new Notice(
				`No alive tmux sessions found for ${project}. Use "Create new terminal" instead.`,
			);
			return;
		}

		const missing = aliveSessions.filter((s) => !openSessionNames.has(s));

		if (missing.length === 0) {
			new Notice("All sessions for this project are already open.");
			return;
		}

		for (const sessionName of missing) {
			await this.createTerminalLeaf(project, sessionName);
		}
		new Notice(`Restored ${missing.length} terminal(s).`);
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

	// --- Shared helpers ---

	private tmuxLs(): Promise<string> {
		// Obsidian's Electron process may not include /opt/homebrew/bin
		// in PATH, so we prepend common locations.
		const prependPath = ["/opt/homebrew/bin", "/usr/local/bin"];
		const existingPath = process.env.PATH || "/usr/bin:/bin";
		const entries = existingPath.split(":");
		for (const p of prependPath) {
			if (!entries.includes(p)) entries.unshift(p);
		}

		return new Promise((resolve) => {
			execFile(
				"tmux",
				["ls"],
				{ env: { ...process.env, PATH: entries.join(":") } },
				(err, stdout) => {
					resolve(err ? "" : stdout);
				},
			);
		});
	}

	private async createTerminalLeaf(
		project: string | null,
		sessionName: string | null,
	): Promise<void> {
		const { workspace } = this.app;

		// Always create in the right sidebar.
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({
			type: VIEW_TYPE_TERMINAL,
			active: true,
		});

		const view = leaf.view;
		if (view instanceof TerminalView) {
			view.setProject(project, sessionName ?? undefined);
		}
		workspace.revealLeaf(leaf);
	}

	private resolveActiveProject(): string | null {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return null;
		const match = activeFile.path.match(PROJECT_PATH_RE);
		return match ? match[1] : null;
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
			.setName("Auto-reveal note on terminal focus")
			.setDesc(
				"When clicking a terminal, automatically show the last-opened note for that project in the main editor.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoRevealNote)
					.onChange(async (value) => {
						this.plugin.settings.autoRevealNote = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Queue panel")
			.setDesc(
				"Show history and queue panels above/below the terminal. Enables task queuing per session.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.queuePanel)
					.onChange(async (value) => {
						this.plugin.settings.queuePanel = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
