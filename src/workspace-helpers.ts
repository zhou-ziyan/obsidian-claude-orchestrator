import type { Workspace, WorkspaceLeaf } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";

export function findTerminalLeafBySession(
	workspace: Workspace,
	sessionName: string,
): { leaf: WorkspaceLeaf; view: TerminalView } | null {
	for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
		const view = leaf.view;
		if (view instanceof TerminalView && view.getSessionName() === sessionName) {
			return { leaf, view };
		}
	}
	return null;
}

export function collectOpenSessionNames(workspace: Workspace): Set<string> {
	const names = new Set<string>();
	for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
		const view = leaf.view;
		if (view instanceof TerminalView) {
			const name = view.getSessionName();
			if (name) names.add(name);
		}
	}
	return names;
}

export function findTerminalLeafByProject(
	workspace: Workspace,
	project: string,
): { leaf: WorkspaceLeaf; view: TerminalView } | null {
	for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
		const view = leaf.view;
		if (view instanceof TerminalView && view.getProject() === project) {
			return { leaf, view };
		}
	}
	return null;
}
