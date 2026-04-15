# Claude Orchestrator

Obsidian plugin that runs Claude Code sessions inside the Obsidian window — each project folder mapped to its own tmux session, with a central task queue for dispatching work across sessions.

## Status

- **M1 (embedded terminal)**: ✓ complete
  - xterm.js view docked to the right sidebar
  - Real PTY via `node-pty` (N-API prebuilt binary, loaded with an absolute-path shim to work around Obsidian renderer's relative-require quirk)
  - UTF-8 locale forced so Chinese / other non-ASCII input renders correctly
  - Shell auto-restarts on any keypress after `exit` / `Ctrl+D`
- **M2 (per-project tmux)**: not started
- **M3 (task dispatch)**: not started
- **M4 (summaries)**: not started

Full design doc (milestones, open design questions) lives in the author's Obsidian vault at `Work/01_Projects/15_Claude_Orchestrator/`.

## Dev setup

```bash
git clone <this repo> ~/code/obsidian-claude-orchestrator
cd ~/code/obsidian-claude-orchestrator
npm install
npm run dev   # esbuild watch mode
```

Symlink into your Obsidian vault's plugins directory:

```bash
ln -s "$(pwd)" "<vault>/.obsidian/plugins/claude-orchestrator"
```

Then in Obsidian: Settings → Community plugins → enable **Claude Orchestrator** → `Cmd+P` → "Claude Orchestrator: Open terminal".

## Usage

Open the command palette and run **Claude Orchestrator: Open terminal**. A terminal appears docked in the right sidebar, running your `$SHELL` in `$HOME`. Exit with `exit` / `Ctrl+D`, press any key to restart.

## License

MIT
