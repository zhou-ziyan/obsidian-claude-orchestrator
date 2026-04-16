import { FileSystemAdapter, ItemView, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { normalizeViewState } from "./utils";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { IPty } from "node-pty";
import * as os from "os";
import * as path from "path";

export const VIEW_TYPE_TERMINAL = "claude-orchestrator-terminal";

export interface TerminalViewState {
	project?: string;
	sessionName?: string;
}

/**
 * Obsidian's renderer-side require fails node-pty's internal relative loads
 * (`require("../prebuilds/darwin-arm64//pty.node")` from lib/utils.js returns
 * "Cannot find module"). The absolute-path require works. So we preload
 * node-pty's utils module and swap its loader to use absolute paths before
 * requiring node-pty itself.
 */
function loadNodePty(pluginDir: string): typeof import("node-pty") {
	const ptyRoot = path.join(pluginDir, "node_modules", "node-pty");
	const platformDir = `${process.platform}-${process.arch}`;
	const prebuildDir = path.join(ptyRoot, "prebuilds", platformDir);
	const nativeBinaryPath = path.join(prebuildDir, "pty.node");

	const utils = require(path.join(ptyRoot, "lib", "utils.js"));
	const nativeBinary = require(nativeBinaryPath);
	utils.loadNativeModule = (_name: string) => ({
		dir: prebuildDir,
		module: nativeBinary,
	});

	return require(path.join(ptyRoot, "lib", "index.js"));
}

export class TerminalView extends ItemView {
	private term: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ptyProcess: IPty | null = null;
	private ptyGen = 0;
	private resizeObserver: ResizeObserver | null = null;
	private pluginDir: string;
	private ptyModule: typeof import("node-pty") | null = null;
	private awaitingRestart = false;
	private project: string | null = null;
	private sessionName: string | null = null;
	private xtermReady = false;
	private stateSeenPreOpen = false;
	private host: HTMLElement | null = null;
	private onTerminalFocus?: (project: string) => void;

	constructor(
		leaf: WorkspaceLeaf,
		pluginDir: string,
		onTerminalFocus?: (project: string) => void,
	) {
		super(leaf);
		this.pluginDir = pluginDir;
		this.onTerminalFocus = onTerminalFocus;
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return this.sessionName
			? `Claude Orchestrator: ${this.sessionName}`
			: "Claude Orchestrator";
	}

	getIcon(): string {
		return "terminal";
	}

	getState(): Record<string, unknown> {
		return {
			...super.getState(),
			project: this.project ?? undefined,
			sessionName: this.sessionName ?? undefined,
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const normalized = normalizeViewState(state);
		this.project = normalized.project;
		this.sessionName = normalized.sessionName;
		if (!this.xtermReady) {
			this.stateSeenPreOpen = true;
		}
		await super.setState(state, result);
		if (this.xtermReady && !this.ptyProcess) {
			this.spawnShell();
		}
	}

	getProject(): string | null {
		return this.project;
	}

	getSessionName(): string | null {
		return this.sessionName;
	}

	setProject(project: string | null, sessionName?: string): void {
		this.project = project;
		this.sessionName = sessionName ?? project;
		if (this.xtermReady) {
			this.spawnShell();
		}
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.style.padding = "0";

		const host = container.createDiv({ cls: "claude-orchestrator-term-host" });
		host.style.width = "100%";
		host.style.height = "100%";
		host.style.overflow = "hidden";
		host.style.minWidth = "0";
		this.host = host;

		host.addEventListener("focusin", this.onHostFocusIn);
		host.addEventListener("focusout", this.onHostFocusOut);

		this.term = new Terminal({
			cursorBlink: true,
			fontFamily: "Menlo, Monaco, 'Courier New', monospace",
			fontSize: 13,
			lineHeight: 1.2,
			theme: {
				background: "#1e1e1e",
				foreground: "#d4d4d4",
			},
		});
		this.fitAddon = new FitAddon();
		this.term.loadAddon(this.fitAddon);
		this.term.open(host);
		this.fitAddon.fit();

		try {
			this.ptyModule = loadNodePty(this.pluginDir);
		} catch (err) {
			this.term.writeln("\x1b[31mFailed to load node-pty:\x1b[0m");
			this.term.writeln(String(err));
			return;
		}

		this.term.onData((data) => {
			if (this.awaitingRestart) {
				this.awaitingRestart = false;
				this.spawnShell();
				return;
			}
			this.ptyProcess?.write(data);
		});

		this.resizeObserver = new ResizeObserver(() => {
			// Skip transient near-zero sizes during layout animations —
			// fitting at these sizes squashes the terminal to a few cols
			// and the PTY stays narrow even after layout stabilizes.
			if (!this.host || this.host.clientWidth < 50) return;
			this.fitAddon?.fit();
			if (this.term && this.ptyProcess) {
				try {
					this.ptyProcess.resize(this.term.cols, this.term.rows);
				} catch {
					/* ignore resize errors */
				}
			}
		});
		this.resizeObserver.observe(host);

		this.xtermReady = true;

		// Only auto-spawn on the state-restore path (setState fired before
		// onOpen). For fresh-creation via activateView, setProject will be
		// called immediately after and drives the spawn.
		if (this.stateSeenPreOpen) {
			this.spawnShell();
		}
	}

	private computeCwd(): string {
		if (this.project) {
			const adapter = this.app.vault.adapter;
			if (adapter instanceof FileSystemAdapter) {
				return path.join(adapter.getBasePath(), "01_Projects", this.project);
			}
		}
		return os.homedir();
	}

	private spawnShell() {
		if (!this.term || !this.ptyModule) return;

		// Kill any existing pty; the generation guard below ensures its
		// pending callbacks (onExit etc.) become no-ops.
		if (this.ptyProcess) {
			try {
				this.ptyProcess.kill();
			} catch {
				/* ignore */
			}
			this.ptyProcess = null;
		}
		this.awaitingRestart = false;
		this.term.clear();

		const myGen = ++this.ptyGen;

		const shell = process.env.SHELL || "/bin/zsh";
		const cwd = this.computeCwd();

		const prependPath = ["/opt/homebrew/bin", "/usr/local/bin"];
		const existingPath = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
		const pathEntries = existingPath.split(":");
		for (const p of prependPath) {
			if (!pathEntries.includes(p)) pathEntries.unshift(p);
		}
		const env: { [key: string]: string } = {
			...(process.env as { [key: string]: string }),
			LANG: process.env.LANG || "en_US.UTF-8",
			LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
			PATH: pathEntries.join(":"),
		};

		let file: string;
		let args: string[];
		if (this.sessionName) {
			file = "tmux";
			args = ["new-session", "-A", "-s", this.sessionName];
		} else {
			file = shell;
			args = [];
		}

		let newPty: IPty;
		try {
			newPty = this.ptyModule.spawn(file, args, {
				name: "xterm-256color",
				cols: this.term.cols,
				rows: this.term.rows,
				cwd,
				env,
			});
		} catch (err) {
			this.term.writeln("\x1b[31mFailed to spawn:\x1b[0m");
			this.term.writeln(String(err));
			if (this.sessionName) {
				this.term.writeln(`Tried: tmux new-session -A -s ${this.sessionName}`);
				this.term.writeln("Is tmux installed and in PATH?");
			}
			return;
		}

		this.ptyProcess = newPty;

		newPty.onData((data) => {
			if (this.ptyGen !== myGen) return;
			this.term?.write(data);
		});
		newPty.onExit(() => {
			if (this.ptyGen !== myGen) return;
			this.ptyProcess = null;
			this.term?.writeln("\r\n\x1b[2m[exited — press any key to restart]\x1b[0m");
			this.awaitingRestart = true;
		});
	}

	private onHostFocusIn = () => {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.host) {
				view.host.classList.toggle("is-dimmed", view !== this);
			}
		}
		if (this.project && this.onTerminalFocus) {
			this.onTerminalFocus(this.project);
		}
	};

	private onHostFocusOut = () => {
		requestAnimationFrame(() => {
			const active = document.activeElement;
			const anyTerminalFocused = this.app.workspace
				.getLeavesOfType(VIEW_TYPE_TERMINAL)
				.some((leaf) => {
					const view = leaf.view;
					return (
						view instanceof TerminalView &&
						view.host?.contains(active)
					);
				});
			if (!anyTerminalFocused) {
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
					const view = leaf.view;
					if (view instanceof TerminalView && view.host) {
						view.host.classList.remove("is-dimmed");
					}
				}
			}
		});
	};

	async onClose() {
		// Clear dimming on remaining terminals when this one closes
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view;
			if (view instanceof TerminalView && view !== this && view.host) {
				view.host.classList.remove("is-dimmed");
			}
		}
		this.host?.removeEventListener("focusin", this.onHostFocusIn);
		this.host?.removeEventListener("focusout", this.onHostFocusOut);
		this.host = null;
		this.ptyGen++; // invalidate pending callbacks
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		try {
			this.ptyProcess?.kill();
		} catch {
			/* ignore */
		}
		this.ptyProcess = null;
		this.ptyModule = null;
		this.term?.dispose();
		this.term = null;
		this.fitAddon = null;
		this.xtermReady = false;
	}
}
