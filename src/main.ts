import { FileSystemAdapter, Plugin } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";

export default class ClaudeOrchestratorPlugin extends Plugin {
	async onload() {
		const pluginDir = this.resolvePluginDir();

		this.registerView(
			VIEW_TYPE_TERMINAL,
			(leaf) => new TerminalView(leaf, pluginDir),
		);

		this.addCommand({
			id: "open-terminal",
			name: "Open terminal",
			callback: () => this.activateView(),
		});
	}

	async onunload() {
	}

	async activateView() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });
		workspace.revealLeaf(leaf);
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
