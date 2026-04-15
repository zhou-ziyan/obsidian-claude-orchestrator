import { FileSystemAdapter, Plugin } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";

const PROJECTS_DIR = "01_Projects";
const PROJECT_PATH_RE = new RegExp(`(?:^|/)${PROJECTS_DIR}/([^/]+)/`);

export default class ClaudeOrchestratorPlugin extends Plugin {
	async onload() {
		const pluginDir = this.resolvePluginDir();

		this.registerView(
			VIEW_TYPE_TERMINAL,
			(leaf) => new TerminalView(leaf, pluginDir),
		);

		this.addCommand({
			id: "open-terminal",
			name: "Open terminal for current project",
			callback: () => this.activateView(),
		});

		this.addRibbonIcon("terminal", "Open terminal for current project", () => {
			this.activateView();
		});
	}

	async onunload() {
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
			throw new Error("Claude Orchestrator requires a local vault (FileSystemAdapter).");
		}
		if (!this.manifest.dir) {
			throw new Error("Plugin manifest has no dir.");
		}
		return adapter.getFullPath(this.manifest.dir);
	}
}
