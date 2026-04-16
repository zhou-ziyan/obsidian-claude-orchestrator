import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";

const PROJECTS_DIR = "01_Projects";
const PROJECT_PATH_RE = new RegExp(`(?:^|/)${PROJECTS_DIR}/([^/]+)/`);

interface OrchestratorSettings {
	autoRevealNote: boolean;
}

const DEFAULT_SETTINGS: OrchestratorSettings = {
	autoRevealNote: true,
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
				new TerminalView(leaf, pluginDir, (project) =>
					this.onTerminalFocus(project),
				),
		);

		this.addCommand({
			id: "open-terminal",
			name: "Open terminal for current project",
			callback: () => this.activateView(),
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

	async activateView() {
		const { workspace } = this.app;
		const project = this.resolveActiveProject();

		// Reveal existing terminal already bound to this project (or no project).
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.getProject() === project) {
				workspace.revealLeaf(leaf);
				return;
			}
		}

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({
			type: VIEW_TYPE_TERMINAL,
			active: true,
		});

		const view = leaf.view;
		if (view instanceof TerminalView) {
			view.setProject(project);
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
	}
}
