import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./view";
import { SessionManagerView, VIEW_TYPE_SESSION_MANAGER } from "./session-manager-view";
import { generateSessionName, migrateSettings, parseTmuxSessionsForProject, parseAllTmuxSessions, resolveProjectFromPath, tmuxLs, fetchPtyUsage, getPtyStatus, ptyStatusMessage, sessionNotePath, sessionDirPath, sessionNameFromNotePath, projectFromSessionName, parseSessionNote, serializeSessionNote, createDefaultSessionNote, ensureEngineHookConfig, materializeHookScripts, hookScriptsDir, HOOK_SCRIPT_SOURCES, bundleGeneration, inspectHookReadiness, QUICK_REPLY_KEYS, parseQuickReplyKeys, BUILTIN_SLASH_COMMANDS, migrateThemeName, execTmux, StopSignalLedger, stopSignalKey, availableEngineIds, engineCreatesHookFile, engineHookRegistrations, engineSettingsPath, loadSlashCommandsFor, resolveEngineRef, newSessionEngine, isEngineId, ENGINE_IDS, getEngineDefinition, DEFAULT_ENGINE_ID, computeSessionCwd, resolveEngineBinary, launchWorkerSession, shellQuote } from "./utils";
import type { EngineId, HookReadinessSnapshot, HookScriptFs, ProjectRegistry, ProviderHookReadiness, QueueMode, SessionNote, SlashCommandEntry, StopReason, ThemeName } from "./utils";
import { QUEUE_MODES, queueModeLabel } from "./utils";
import { QueueEngine } from "./queue-engine";
import { StopHookWatcher } from "./stop-hook-watcher";
import { findTerminalLeafBySession, findTerminalLeafByProject, collectOpenSessionNames } from "./workspace-helpers";
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { homedir } from "os";

export interface OrchestratorSettings {
	simpleMode: boolean;
	projects: ProjectRegistry;
	quickReplyKeys: string[];
	sessionOrder: Record<string, string[]>;
	playSoundOnAsking: boolean;
	theme: ThemeName;
	autoSendCountdownSeconds: number;
	defaultQueueMode: QueueMode;
	/** Engine new sessions start on when the project does not override it. */
	defaultEngine: EngineId;
	/** Maximum number of Manager-launched workers alive at once. */
	maxWorkerSessions: number;
}

const DEFAULT_SETTINGS: OrchestratorSettings = {
	simpleMode: false,
	projects: {},
	quickReplyKeys: [...QUICK_REPLY_KEYS],
	sessionOrder: {},
	playSoundOnAsking: true,
	theme: "obsidian",
	autoSendCountdownSeconds: 3,
	defaultQueueMode: "manual",
	defaultEngine: DEFAULT_ENGINE_ID,
	maxWorkerSessions: 2,
};

/** Node-backed {@link HookScriptFs} used outside tests. */
const nodeHookScriptFs: HookScriptFs = {
	ensureDir(dir) {
		mkdirSync(dir, { recursive: true });
	},
	readFile(path) {
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return null;
		}
	},
	writeFile(path, content) {
		writeFileSync(path, content, "utf-8");
	},
	chmod(path, mode) {
		chmodSync(path, mode);
	},
	isExecutableFile(path) {
		try {
			if (!statSync(path).isFile()) return false;
			accessSync(path, fsConstants.X_OK);
			return true;
		} catch {
			return false;
		}
	},
};

export default class ClaudeOrchestratorPlugin extends Plugin {
	settings: OrchestratorSettings = DEFAULT_SETTINGS;
	queueEngine!: QueueEngine;
	private slashCommands: SlashCommandEntry[] = [...BUILTIN_SLASH_COMMANDS];
	private stopHookWatcher: StopHookWatcher | null = null;
	// Hooks can fire more than once and the signal dir is polled as well as
	// watched; without this a single turn-end could advance the queue twice.
	private signalLedger = new StopSignalLedger();
	private loadedRuntimeGeneration = "unavailable";
	private hookReadiness: HookReadinessSnapshot = {
		state: "repair-required",
		checkedAt: 0,
		loadedRuntimeGeneration: "unavailable",
		diskBundleGeneration: null,
		providers: {},
	};

	async onload() {
		await this.loadSettings();
		await this.autoDiscoverProjects();

		const pluginDir = this.resolvePluginDir();
		this.loadedRuntimeGeneration = this.readBundleGeneration(pluginDir) ?? "unavailable";
		this.ensureEngineHooksRegistered();
		this.refreshHookReadiness(pluginDir, true);

		// Headless queue engine — owns the stop-signal → status/history →
		// auto-send pipeline for every managed session, panel or not.
		this.queueEngine = new QueueEngine({
			store: {
				read: (session) => this.readSessionNote(session),
				write: (session, note) => this.writeSessionNote(session, note),
			},
			exec: execTmux,
			notifier: {
				notify: (message) => this.notifyUser(message),
				soundOnAsking: () => this.playSound(),
			},
			getCountdownSeconds: () => this.settings.autoSendCountdownSeconds,
			playSoundOnAsking: () => this.settings.playSoundOnAsking,
			getHookReadiness: (provider) => this.providerHookReadiness(provider),
			onUpdate: () => {
				/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- custom workspace event */
				this.app.workspace.trigger("claude-orchestrator:countdown-tick" as any);
				/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
			},
		});

		// Engine reacts to session note edits (view saves, external agents,
		// hand edits) — replaces the old view-level auto-send checks.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				const session = sessionNameFromNotePath(file.path, this.settings.projects);
				if (session && !this.queueEngine.isSelfWrite(session)) {
					void this.queueEngine.onNoteChanged(session);
				}
			}),
		);

		this.registerView(
			VIEW_TYPE_TERMINAL,
			(leaf) =>
				new TerminalView(
					leaf,
					pluginDir,
					() => ({ ...this.settings, slashCommands: this.slashCommands }),
					() => this.queueEngine,
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
			id: "launch-worker-session",
			name: "Launch worker session for current project",
			callback: () => this.launchWorkerForActiveProject(),
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

		// Stop hook watcher — the engine owns the pipeline; views only get
		// notified for UI touches (ask highlight).
		this.stopHookWatcher = new StopHookWatcher(
			() => this.settings.projects,
			() => this.app.vault.getName(),
		);
		this.stopHookWatcher.onSignal((signal) => {
			const ledger = this.signalLedger.evaluate(signal);
			if (!ledger.accepted) {
				this.queueEngine.recordRejectedSignal(signal.tmuxSession, ledger.reason ?? "duplicate");
				return;
			}
			const reason = signal.stopReason;
			if (!reason) return;
			void this.queueEngine.onLifecycleSignal(
				signal.tmuxSession,
				reason,
				signal.provider,
				stopSignalKey(signal),
				{
					sessionId: signal.sessionId,
					turnId: signal.turnId,
					timestamp: signal.timestamp,
					source: "hook",
				},
			);
			this.routeStopSignalToView(signal.tmuxSession, reason);
			this.refreshSessionManager();
		});
		this.stopHookWatcher.onDiagnostic((diagnostic) => {
			if (diagnostic.tmuxSession) {
				this.queueEngine.recordRejectedSignal(diagnostic.tmuxSession, diagnostic.reason);
			}
			this.refreshSessionManager();
		});
		this.stopHookWatcher.start();
		this.registerInterval(window.setInterval(() => {
			this.refreshHookReadiness(pluginDir, false);
		}, 5_000));
	}

	onunload() {
		this.stopHookWatcher?.stop();
		this.queueEngine.dispose();
	}

	// Slash completion is engine-scoped: the engine definition decides both
	// the builtin command list and where skills live on disk.
	private loadSlashCommands(): void {
		const roots = [homedir()];
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			roots.push(adapter.getBasePath());
		}
		for (const config of Object.values(this.settings.projects)) {
			if (config.workingDirectory) {
				roots.push(config.workingDirectory);
			}
		}
		this.slashCommands = loadSlashCommandsFor(resolveEngineRef(DEFAULT_ENGINE_ID), roots);
	}

	async loadSettings() {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Obsidian loadData() returns any
		const raw: Record<string, unknown> = await this.loadData() ?? {};
		const data = migrateSettings(raw);
		this.settings = { ...DEFAULT_SETTINGS, ...data as Partial<OrchestratorSettings> };
		const maxWorkers = Number(this.settings.maxWorkerSessions);
		this.settings.maxWorkerSessions = Number.isFinite(maxWorkers)
			? Math.max(0, Math.min(20, Math.round(maxWorkers)))
			: DEFAULT_SETTINGS.maxWorkerSessions;
		this.settings.theme = migrateThemeName(this.settings.theme);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.loadSlashCommands();
	}

	/** Engine a new session in this project should start on. */
	/** Engine to stamp on a session being created now. Never consulted for
	 * sessions that already exist — their note is the only source. */
	defaultEngineForProject(project: string | null): EngineId {
		const config = project ? this.settings.projects[project] : undefined;
		return newSessionEngine(config?.defaultEngine, this.settings.defaultEngine);
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

	private engineLaunches = new Map<string, Promise<{ kind: "created" | "existing"; sessionName: string }>>();

	/** Launch one explicitly configured Claude/Codex worker without opening a panel. */
	async launchWorkerForProject(project: string, engine: EngineId): Promise<{ kind: "created" | "existing"; sessionName: string }> {
		const key = `worker:${project}:${engine}`;
		const pending = this.engineLaunches.get(key);
		if (pending) return pending;
		const operation = this.launchEngineSessionForProject(project, engine, "worker").then((result) => {
			new Notice(result.kind === "created"
				? `Launched ${engine} worker ${result.sessionName}`
				: `Worker already running: ${result.sessionName}`);
			return result;
		}).finally(() => {
			if (this.engineLaunches.get(key) === operation) this.engineLaunches.delete(key);
		});
		this.engineLaunches.set(key, operation);
		return operation;
	}

	private async launchEngineSessionForProject(
		project: string,
		engine: EngineId,
		kind: "worker" | "interactive",
	): Promise<{ kind: "created" | "existing"; sessionName: string }> {
		const config = this.settings.projects[project];
		if (!config) throw new Error(`Unknown project: ${project}`);
		if (config.inactive) throw new Error(`Project is inactive: ${project}`);
		const permission = config.workerPermissions?.[engine];
		const adapter = this.app.vault.adapter;
		const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
		const cwd = computeSessionCwd(config.workingDirectory, config.vaultFolder, basePath, homedir());
		const cwdExists = existsSync(cwd) && statSync(cwd).isDirectory();
		const definition = getEngineDefinition(engine);
		if (!definition) throw new Error(`Unknown engine: ${engine}`);
		const binary = resolveEngineBinary(definition, homedir(), existsSync);
		let binaryExists = existsSync(binary);
		if (!binaryExists && !binary.includes("/")) {
			try {
				execFileSync("/bin/sh", ["-lc", `command -v -- ${shellQuote(binary)}`], { stdio: "ignore" });
				binaryExists = true;
			} catch { /* preflight reports the missing binary */ }
		}
		const openNames = this.collectSessionNames();
		const tmuxOutput = await tmuxLs();
		for (const session of parseAllTmuxSessions(tmuxOutput)) openNames.add(session.name);
		const sessionName = generateSessionName(project, openNames);
		const dirPath = sessionDirPath(config.vaultFolder);
		const notePath = sessionNotePath(config.vaultFolder, sessionName);
		const noteContent = createDefaultSessionNote(sessionName, this.settings.defaultQueueMode, engine);
		const result = await launchWorkerSession({
			project, engine, sessionName, cwd, binary, permission,
			maxConcurrent: kind === "worker" ? this.settings.maxWorkerSessions : 0,
			notePath, noteContent, vaultId: this.app.vault.getName(),
			kind,
			reuseExisting: kind === "worker",
		}, {
			exec: execTmux,
			cwdExists,
			binaryExists,
			createNote: async (path, content) => {
				if (!this.app.vault.getAbstractFileByPath(dirPath)) await this.app.vault.createFolder(dirPath);
				await this.app.vault.create(path, content);
			},
			deleteNote: async (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file) await this.app.fileManager.trashFile(file);
			},
		});
		return result;
	}

	private async launchWorkerForActiveProject(): Promise<void> {
		const project = this.resolveActiveProject();
		if (!project) {
			new Notice("No project context — open a project note first.");
			return;
		}
		const engine = this.defaultEngineForProject(project);
		try {
			await this.launchWorkerForProject(project, engine);
		} catch (error) {
			new Notice(`Worker launch failed: ${error instanceof Error ? error.message : String(error)}`);
		}
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

	/**
	 * Create a session that runs `engine`.
	 *
	 * The engine is written onto the note here, at creation, because that is
	 * the only moment it is decided. Leaving the note blank would make the
	 * session's engine depend on whatever the default happens to be later.
	 */
	async createNewTerminalForProject(project: string, engine?: EngineId) {
		const chosen = engine ?? this.defaultEngineForProject(project);
		const key = `interactive:${project}:${chosen}`;
		const pending = this.engineLaunches.get(key);
		const operation = pending ?? this.launchEngineSessionForProject(project, chosen, "interactive");
		if (!pending) {
			this.engineLaunches.set(key, operation);
			void operation.finally(() => {
				if (this.engineLaunches.get(key) === operation) this.engineLaunches.delete(key);
			});
		}
		try {
			const result = await operation;
			await this.createTerminalLeaf(project, result.sessionName);
			new Notice(`Started ${chosen} session ${result.sessionName}`);
		} catch (error) {
			new Notice(`Session start failed: ${error instanceof Error ? error.message : String(error)}`);
		}
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

	// --- Engine note store (session name → vault file) ---

	private sessionNoteFile(sessionName: string): TFile | null {
		const project = projectFromSessionName(sessionName, this.settings.projects);
		if (!project) return null;
		const config = this.settings.projects[project];
		if (!config) return null;
		const file = this.app.vault.getAbstractFileByPath(sessionNotePath(config.vaultFolder, sessionName));
		return file instanceof TFile ? file : null;
	}

	private async readSessionNote(sessionName: string): Promise<SessionNote | null> {
		const file = this.sessionNoteFile(sessionName);
		if (!file) return null;
		const content = await this.app.vault.read(file);
		return parseSessionNote(content, sessionName);
	}

	private async writeSessionNote(sessionName: string, note: SessionNote): Promise<void> {
		const file = this.sessionNoteFile(sessionName);
		if (!file) return;
		await this.app.vault.modify(file, serializeSessionNote(note));
	}

	private playSound(): void {
		const { execFile } = require("child_process") as typeof import("child_process");
		execFile("afplay", ["/System/Library/Sounds/Glass.aiff"], () => {});
	}

	private notifyUser(message: string): void {
		new Notice(message);
		try {
			new Notification("Claude Orchestrator", { body: message });
		} catch { /* Notification API may not be available */ }
		this.playSound();
	}

	private refreshSessionManager() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION_MANAGER)) {
			const view = leaf.view;
			if (view instanceof SessionManagerView) {
				void view.refresh();
			}
		}
	}

	private routeStopSignalToView(tmuxSession: string, reason: StopReason): boolean {
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

	getHookReadinessSnapshot(): HookReadinessSnapshot {
		return this.hookReadiness;
	}

	getProviderHookReadiness(provider: string): ProviderHookReadiness {
		return this.providerHookReadiness(provider);
	}

	private providerHookReadiness(provider: string): ProviderHookReadiness {
		return this.hookReadiness.providers[provider] ?? {
			provider,
			ready: false,
			state: "repair-required",
			reason: "Hook repair required: provider readiness is unavailable",
			issues: [{ code: "settings-unreadable" }],
		};
	}

	private readBundleGeneration(pluginDir: string): string | null {
		try {
			return bundleGeneration(readFileSync(join(pluginDir, "main.js"), "utf-8"));
		} catch {
			return null;
		}
	}

	private refreshHookReadiness(pluginDir: string, announce: boolean): void {
		const home = homedir();
		const scriptsDir = hookScriptsDir(home);
		const providerInputs = availableEngineIds().map((id) => {
			const ref = resolveEngineRef(id);
			const settingsPath = engineSettingsPath(ref, home);
			let settingsJson: string | null = null;
			if (settingsPath) {
				try { settingsJson = readFileSync(settingsPath, "utf-8"); } catch { /* diagnosed below */ }
			}
			const registrations = engineHookRegistrations(ref, scriptsDir).map((registration) => {
				let actualSource: string | null = null;
				let executable = false;
				try { actualSource = readFileSync(registration.scriptPath, "utf-8"); } catch { /* diagnosed below */ }
				try {
					executable = statSync(registration.scriptPath).isFile();
					accessSync(registration.scriptPath, fsConstants.X_OK);
				} catch { executable = false; }
				return {
					role: registration.role,
					event: registration.event,
					scriptName: registration.scriptName,
					expectedPath: registration.scriptPath,
					expectedSource: HOOK_SCRIPT_SOURCES[registration.scriptName] ?? "",
					actualSource,
					executable,
				};
			});
			return { provider: id, settingsJson, registrations };
		});

		const previousState = this.hookReadiness.state;
		this.hookReadiness = inspectHookReadiness({
			checkedAt: Date.now(),
			loadedRuntimeGeneration: this.loadedRuntimeGeneration,
			diskBundleGeneration: this.readBundleGeneration(pluginDir),
			providers: providerInputs,
		});
		if (announce || previousState !== this.hookReadiness.state) {
			if (this.hookReadiness.state === "reload-required") {
				new Notice("Claude Orchestrator Auto Queue is blocked: reload Obsidian to activate the current bundle.", 10000);
			} else if (this.hookReadiness.state === "repair-required") {
				new Notice("Claude Orchestrator Auto Queue is blocked: lifecycle hook repair is required. Open Session Manager for details.", 10000);
			} else if (previousState !== "ready") {
				new Notice("Claude Orchestrator lifecycle hooks are ready.", 5000);
			}
		}
		this.refreshSessionManager();
	}

	/**
	 * Install the bundled hook scripts, then register them in each engine's
	 * settings file.
	 *
	 * Two things are going on:
	 * - The scripts are written at load time rather than shipped as files.
	 *   BRAT and the release zip install only main.js / manifest.json /
	 *   styles.css, so a scripts/ directory next to the plugin only ever
	 *   existed on a dev checkout, and released installs registered hooks
	 *   pointing at files that could not run. They go to one fixed directory
	 *   rather than under the plugin so every vault registers an identical
	 *   command instead of rewriting the shared settings file over its
	 *   neighbours. See src/hook-scripts.ts.
	 * - Which hooks to register comes from each engine definition rather than
	 *   a hard-coded ~/.claude/settings.json, so adding an engine that reports
	 *   turn completion needs no change here.
	 */
	private ensureEngineHooksRegistered(): void {
		const home = homedir();
		const { paths, errors } = materializeHookScripts(home, nodeHookScriptFs);

		if (errors.length > 0) {
			// Visible, not silent: without a runnable script the plugin cannot
			// tell when a session finishes, and the panel just looks stuck.
			new Notice(
				`Claude Orchestrator could not install its hook scripts:\n${errors.join("\n")}`,
				10000,
			);
		}

		const scriptsDir = hookScriptsDir(home);
		for (const id of availableEngineIds()) {
			const ref = resolveEngineRef(id);
			const settingsPath = engineSettingsPath(ref, home);
			// Only scripts we actually installed: registering a path that does
			// not exist would replace a working entry with a broken one, and
			// the settings file is shared with every other vault.
			const registrations = engineHookRegistrations(ref, scriptsDir)
				.filter((reg) => paths[reg.scriptName]);
			if (!settingsPath || registrations.length === 0) continue;
			try {
				let content: string;
				try {
					content = readFileSync(settingsPath, "utf-8");
				} catch {
					if (!engineCreatesHookFile(ref)) continue;
					mkdirSync(dirname(settingsPath), { recursive: true });
					content = "{}";
				}
				let updated = false;
				for (const reg of registrations) {
					const result = ensureEngineHookConfig(content, reg.event, reg.scriptName, paths[reg.scriptName] ?? null);
					if (result.updated) { content = result.content; updated = true; }
				}
				if (updated) {
					writeFileSync(settingsPath, content, "utf-8");
				}
			} catch {
				// Settings file doesn't exist or isn't readable — skip
			}
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
			.setName("Auto-send countdown (seconds)")
			.setDesc("How many seconds to count down before auto-sending the next queue item. Range: 1–30.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.autoSendCountdownSeconds))
					.onChange(async (value) => {
						const n = Math.max(1, Math.min(30, Math.round(Number(value) || 3)));
						this.plugin.settings.autoSendCountdownSeconds = n;
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
			.setName("Default engine")
			.setDesc("Engine new sessions start on, unless a project overrides it.")
			.addDropdown((dropdown) => {
				for (const id of ENGINE_IDS) {
					const def = getEngineDefinition(id);
					if (def) dropdown.addOption(id, def.label);
				}
				dropdown
					.setValue(this.plugin.settings.defaultEngine)
					.onChange(async (value) => {
						if (!isEngineId(value)) return;
						this.plugin.settings.defaultEngine = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Maximum unattended workers")
			.setDesc("Maximum number of Manager-launched workers. Project permission policies still apply.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxWorkerSessions))
					.onChange(async (value) => {
						this.plugin.settings.maxWorkerSessions = Math.max(0, Math.min(20, Math.round(Number(value) || 0)));
						await this.plugin.saveSettings();
					}),
			);

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
