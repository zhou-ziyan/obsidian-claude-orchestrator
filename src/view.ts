import { ItemView, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { IPty } from "node-pty";
import * as os from "os";
import * as path from "path";

export const VIEW_TYPE_TERMINAL = "claude-orchestrator-terminal";

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
	private resizeObserver: ResizeObserver | null = null;
	private pluginDir: string;
	private ptyModule: typeof import("node-pty") | null = null;
	private awaitingRestart = false;

	constructor(leaf: WorkspaceLeaf, pluginDir: string) {
		super(leaf);
		this.pluginDir = pluginDir;
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return "Claude Orchestrator";
	}

	getIcon(): string {
		return "terminal";
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.style.padding = "0";

		const host = container.createDiv({ cls: "claude-orchestrator-term-host" });
		host.style.width = "100%";
		host.style.height = "100%";

		this.term = new Terminal({
			cursorBlink: true,
			fontFamily: "Menlo, Monaco, 'Courier New', monospace",
			fontSize: 13,
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
				this.term?.clear();
				this.spawnShell();
				return;
			}
			this.ptyProcess?.write(data);
		});

		this.resizeObserver = new ResizeObserver(() => {
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

		this.spawnShell();
	}

	private spawnShell() {
		if (!this.term || !this.ptyModule) return;

		const shell = process.env.SHELL || "/bin/zsh";
		const cwd = os.homedir();
		const env: { [key: string]: string } = {
			...(process.env as { [key: string]: string }),
			LANG: process.env.LANG || "en_US.UTF-8",
			LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
		};
		try {
			this.ptyProcess = this.ptyModule.spawn(shell, [], {
				name: "xterm-256color",
				cols: this.term.cols,
				rows: this.term.rows,
				cwd,
				env,
			});
		} catch (err) {
			this.term.writeln("\x1b[31mFailed to spawn pty:\x1b[0m");
			this.term.writeln(String(err));
			return;
		}

		this.ptyProcess.onData((data) => this.term?.write(data));
		this.ptyProcess.onExit(() => {
			this.ptyProcess = null;
			this.term?.writeln("\r\n\x1b[2m[shell exited — press any key to restart]\x1b[0m");
			this.awaitingRestart = true;
		});
	}

	async onClose() {
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
	}
}
