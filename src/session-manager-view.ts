import { ItemView, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";
import {
	tmuxLs,
	parseAllTmuxSessions,
	groupSessionsByProject,
	sessionNotePath,
	parseSessionNote,
	projectFromSessionName,
	SessionGroup,
	SessionInfo,
} from "./utils";
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
		refreshBtn.addEventListener("click", () => this.refresh());

		// Session list
		this.listEl = container.createDiv({ cls: "co-sm-list" });

		// Initial load
		await this.refresh();

		// Workspace events — real-time sync for managed sessions
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.refresh()),
		);

		// Session note changes
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path.includes("/sessions/") && file.path.endsWith(".md")) {
					this.refresh();
				}
			}),
		);

		// Low-frequency polling for external tmux changes
		this.pollTimer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
	}

	async onClose() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.listEl = null;
	}

	async refresh() {
		if (!this.listEl) return;

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

		for (const s of allSessions) {
			const project = projectFromSessionName(s.name);
			if (!project) continue;
			const notePath = sessionNotePath(project, s.name);
			const file = this.app.vault.getAbstractFileByPath(notePath);
			if (!file || file instanceof TFolder) continue;
			try {
				const content = await this.app.vault.read(file as TFile);
				const note = parseSessionNote(content, s.name);
				// Extract last activity from most recent history/queue timestamp
				let lastActivity: string | null = null;
				const allItems = [
					...note.history.map((h) => h.text),
					...note.queue,
				];
				for (let i = allItems.length - 1; i >= 0; i--) {
					const m = allItems[i].match(TIMESTAMP_RE);
					if (m) {
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
		this.groups = groupSessionsByProject(allSessions, openNames, noteData);

		// 5. Render
		this.render();
	}

	private render() {
		if (!this.listEl) return;
		this.listEl.empty();

		if (this.groups.length === 0) {
			this.listEl.createDiv({
				cls: "co-sm-empty",
				text: "No tmux sessions running.",
			});
			return;
		}

		for (const group of this.groups) {
			this.renderGroup(group);
		}
	}

	private renderGroup(group: SessionGroup) {
		if (!this.listEl) return;
		const collapsed = this.collapsedProjects.has(group.project);

		const groupEl = this.listEl.createDiv({ cls: "co-sm-group" });

		// Group header
		const groupHeader = groupEl.createDiv({ cls: "co-sm-group-header" });
		const arrow = groupHeader.createSpan({
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

	private renderSessionCard(parent: HTMLElement, session: SessionInfo) {
		const card = parent.createDiv({ cls: "co-sm-card" });

		// Session name
		const nameRow = card.createDiv({ cls: "co-sm-card-name" });
		// Indicator dot: green if has open panel, grey if not
		nameRow.createSpan({
			cls: `co-sm-dot ${session.hasPanel ? "co-sm-dot-active" : ""}`,
			text: "●",
		});
		nameRow.createSpan({ text: session.name.replace(/^\d+_/, "").replace(/-(\d+)$/, " #$1") });

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

		// Actions
		const actions = card.createDiv({ cls: "co-sm-card-actions" });

		if (session.hasPanel) {
			// Focus button — reveal existing terminal
			const focusBtn = actions.createEl("button", {
				cls: "co-text-btn",
				text: "Focus",
			});
			focusBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.focusSession(session.name);
			});

			// Send next — only if queue has items
			if (session.queueCount > 0) {
				const sendBtn = actions.createEl("button", {
					cls: "co-text-btn co-accent",
					text: "Send ▶",
				});
				sendBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.sendNextForSession(session.name);
				});
			}
		} else {
			// Attach button — create panel for this session
			const attachBtn = actions.createEl("button", {
				cls: "co-text-btn",
				text: "Attach",
			});
			attachBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.attachSession(session);
			});
		}

		// Kill button — always available
		const killBtn = actions.createEl("button", {
			cls: "co-text-btn co-sm-kill",
			text: "Kill",
		});
		killBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.killSession(session.name);
		});
	}

	// --- Actions ---

	private focusSession(sessionName: string) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.getSessionName() === sessionName) {
				this.app.workspace.revealLeaf(leaf);
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
				setTimeout(() => this.refresh(), 300);
				return;
			}
		}
	}

	private async attachSession(session: SessionInfo) {
		const project = projectFromSessionName(session.name);
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
		workspace.revealLeaf(leaf);

		// Refresh to update hasPanel state
		setTimeout(() => this.refresh(), 500);
	}

	private async killSession(sessionName: string) {
		const { execFile } = require("child_process");
		const prependPath = ["/opt/homebrew/bin", "/usr/local/bin"];
		const existingPath = process.env.PATH || "/usr/bin:/bin";
		const entries = existingPath.split(":");
		for (const p of prependPath) {
			if (!entries.includes(p)) entries.unshift(p);
		}

		await new Promise<void>((resolve) => {
			execFile(
				"tmux",
				["kill-session", "-t", sessionName],
				{ env: { ...process.env, PATH: entries.join(":") } },
				() => resolve(),
			);
		});

		// Refresh to reflect the killed session
		setTimeout(() => this.refresh(), 500);
	}
}

/**
 * Format a "YYYY-MM-DD HH:MM" timestamp as relative time.
 */
function formatRelativeTime(stamp: string): string {
	const [datePart, timePart] = stamp.split(" ");
	if (!datePart || !timePart) return stamp;
	const [y, mo, d] = datePart.split("-").map(Number);
	const [h, mi] = timePart.split(":").map(Number);
	const then = new Date(y, mo - 1, d, h, mi);
	const now = new Date();
	const diffMs = now.getTime() - then.getTime();
	if (diffMs < 0) return stamp;
	const diffMin = Math.floor(diffMs / 60_000);
	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	return `${diffDay}d ago`;
}
