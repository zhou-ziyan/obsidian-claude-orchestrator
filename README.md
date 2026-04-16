# Claude Orchestrator

Obsidian plugin that runs Claude Code sessions inside the Obsidian window — each project folder mapped to its own tmux session, with a task queue for dispatching work across sessions.

## Status

- **M1 (embedded terminal)**: ✓ complete
  - xterm.js view docked to the right sidebar
  - Real PTY via `node-pty` (N-API prebuilt binary, loaded with an absolute-path shim to work around Obsidian renderer's relative-require quirk)
  - UTF-8 locale forced so Chinese / other non-ASCII input renders correctly
  - Shell auto-restarts on any keypress after `exit` / `Ctrl+D`
- **M2 (per-project tmux)**: ✓ complete
  - Opening the terminal while viewing a note under `01_Projects/<NN>_<Name>/` binds the session to a tmux session named after that folder
  - `tmux new-session -A -s <name>` attaches if the session exists, creates it otherwise
  - Multiple terminals can coexist, each bound to a different project
  - Notes outside any project fall back to a plain shell in `$HOME`
  - Focus indicator: clicking a terminal dims all others with a semi-transparent overlay
  - Resize guard: ignores transient near-zero container sizes during layout animations
- **M3a (multi-terminal per project)**: ✓ complete
  - Same project can have multiple terminals with independent tmux sessions (`<project>`, `<project>-2`, `<project>-3`, ...)
  - Three commands: "Open terminal" (reveal or create), "Restore all terminals" (reattach all alive sessions), "Create new terminal" (fresh session)
  - Restore respects tmux activity timestamps — tabs in alphabetical order, most recent session gets focus
- **M3b stage 1 (queue UI + manual send)**: ✓ complete
  - Queue panel (toggled via Settings or `Cmd+P`): add/edit/delete/reorder tasks, "Send next" injects into tmux
  - History panel (collapsible): chronological log of sent tasks
  - Session notes: `sessions/<name>.md` auto-created per session, stores queue + history + pinned note
  - 📌 Pin note: bind a specific note to a session, auto-jumps on terminal focus
  - Timestamps on all items (stored as `[YYYY-MM-DD HH:MM]`, displayed as `HH:MM`)
  - IME-friendly: Chinese input composition doesn't trigger premature submit
  - Tab switch auto-focuses terminal, green ▲ indicator shows terminal focus state
- **M3b stage 2 (auto-send)**: not started — stop hook integration, done-vs-asking detection, countdown timer
- **M4 (task dispatch)**: not started
- **M5 (summaries)**: not started

## Commands

| Command | Description |
|---------|-------------|
| Open terminal for current project | Reveal existing terminal or create one |
| Restore all terminals for current project | Reattach all alive tmux sessions missing a tab |
| Create new terminal for current project | Always create a fresh tmux session |
| Toggle queue panel | Enable/disable the queue UI below the terminal |

## Dev setup

```bash
git clone <this repo> ~/code/obsidian-claude-orchestrator
cd ~/code/obsidian-claude-orchestrator
npm install
npm run dev   # esbuild watch mode
npm test      # 42 tests via node:test
```

Symlink into your Obsidian vault's plugins directory:

```bash
ln -s "$(pwd)" "<vault>/.obsidian/plugins/claude-orchestrator"
```

Then in Obsidian: Settings → Community plugins → enable **Claude Orchestrator** → `Cmd+P` → "Claude Orchestrator: Open terminal".

## Architecture

```
src/
  main.ts    — plugin lifecycle, commands, settings, terminal leaf management
  view.ts    — TerminalView (xterm.js + PTY + queue/history UI)
  utils.ts   — pure functions (session naming, note parsing, tmux output parsing)
tests/
  utils.test.ts — 42 tests for utils.ts (node:test, zero dependencies)
styles.css   — xterm defaults + queue panel + focus indicators
```

## License

MIT
