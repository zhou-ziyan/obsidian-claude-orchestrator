# Claude Orchestrator

Obsidian plugin for running multiple Claude Code sessions inside Obsidian — each project mapped to its own tmux session, with per-session task queues, auto-send on completion, and a Session Manager dashboard.

<img width="1988" height="1118" alt="image" src="https://github.com/user-attachments/assets/ca43b4cc-faa8-47c2-926c-4d74c47e12fe" />

## Features

### Embedded Terminal
- xterm.js view docked to the sidebar, real PTY via `node-pty`
- Per-project tmux binding: open a project note → terminal auto-attaches to that project's tmux session
- Multiple terminals per project (`project-1`, `project-2`, ...) with independent sessions
- Focus indicator: clicking a terminal dims all others with a semi-transparent overlay
- Dark/light theme: follows Obsidian theme automatically

### Task Queue & History
- **Queue panel** below the terminal: add, edit, delete, reorder (▴/▾) tasks
- **"Send next ▶"** injects the next queue item into tmux via `send-keys`
- **History panel** above the terminal: chronological log of sent tasks (✓ complete / ⟳ in-progress)
- **📌 Pin note**: bind a vault note to a session, auto-jumps on terminal focus
- **Image support**: queue items containing `![[img.png]]` or `![alt](path)` render inline thumbnails; paste images from clipboard directly into the input
- Timestamps on all items (`[YYYY-MM-DD HH:MM]`), displayed as relative time
- IME-friendly: Chinese input composition doesn't trigger premature submit

### Auto-Send (M3b Stage 2)
- **Stop hook integration**: Claude Code's Stop hook writes a signal file; the plugin detects it and classifies the stop as "done" or "asking"
- **Queue mode toggle**: Manual / Listen / Auto — persisted per-session in the session note
- **Auto mode**: when Claude finishes (done) and queue is non-empty, Send Next button shows a 3-second red countdown (`Cancel (3s)` → `(2s)` → `(1s)`), then auto-sends. Click to cancel
- **Listen mode**: shows an Obsidian Notice when Claude stops, but doesn't auto-send
- **History auto-mark**: when Claude finishes, the last history item is automatically marked `[x]`

### Session Manager
Left-sidebar dashboard showing all tmux sessions grouped by project:

- **Session cards**: status dot (green = has panel, gray = tmux only), session name, queue count, relative activity time
- **Display name**: double-click the session name to rename (stored in session note `displayName:` field, shown in card + terminal tab title)
- **Notes summary**: first line of session note `## Notes` section shown as italic gray text
- **Message preview**: last queue or history item shown as single-line gray preview
- **Idle detection**: sessions inactive >24h get ⏳ badge + tinted background
- **Hide/unhide**: 👁 button hides a session without killing it; "Show N hidden" toggle at bottom of project group reveals them (semi-transparent)
- **Quick Reply**: 1, 2, Y buttons for fast responses to Claude's questions
- **Actions**: Send ▶ (green when queue has items, gray when empty), Kill × (with 8-second confirmation portal)
- **Per-project controls**: `+` new session, ⧉ restore detached sessions, ⚙ edit project
- **Inactive projects**: zero-session projects fold to bottom "Inactive projects (N)" section
- **PTY usage** (footer): `PTY used/max` with color-coded progress bar (green <70%, yellow 70-90%, red >90%)
- **Project Registry**: register any vault folder as a project (not limited to `01_Projects/` naming)

### PTY Management
- **Pre-spawn check**: refuses to create terminals when PTYs are exhausted (100%), warns at >90%
- **Accurate diagnostics**: spawn failures show PTY usage instead of misleading "Is tmux installed?" error
- **Dashboard**: real-time PTY count in Session Manager footer

## Commands

| Command | Description |
|---------|-------------|
| Open terminal for current project | Reveal existing terminal or create one |
| Restore all terminals for current project | Reattach all alive tmux sessions missing a tab |
| Create new terminal for current project | Always create a fresh tmux session |
| Toggle simple mode | Hide/show queue + history panels |
| Open session manager | Open the session manager panel in left sidebar |

## Dev Setup

```bash
git clone <this repo> ~/code/obsidian-claude-orchestrator
cd ~/code/obsidian-claude-orchestrator
npm install
npm run dev     # esbuild watch mode
npm run check   # lint + typecheck + 313 tests with coverage
npm run build   # auto-bumps patch version, then builds
```

Symlink into your Obsidian vault's plugins directory:

```bash
ln -s "$(pwd)" "<vault>/.obsidian/plugins/claude-orchestrator"
```

Then in Obsidian: Settings → Community plugins → enable **Claude Orchestrator** → `Cmd+P` → "Claude Orchestrator: Open terminal".

### Stop Hook Setup

For auto-send to work, configure Claude Code's Stop hook in the project's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash scripts/co-stop-hook.sh"
          }
        ]
      }
    ]
  }
}
```

The hook script reads the stop event from stdin, identifies the tmux session, and writes a signal file to `/tmp/co-stop/` for the plugin to pick up.

## Architecture

```
src/
  main.ts                  — plugin lifecycle, commands, settings, stop signal routing
  view.ts                  — TerminalView (xterm.js + PTY + queue/history/auto-send UI)
  session-manager-view.ts  — SessionManagerView (left-sidebar session dashboard)
  utils.ts                 — pure functions (session naming, note parsing, tmux helpers,
                             PTY usage, stop signal parsing, queue image parsing)
  workspace-helpers.ts     — shared leaf traversal helpers (findBySession, collectNames)
  stop-hook-watcher.ts     — fs.watch on /tmp/co-stop/ for stop hook signals
scripts/
  auto-bump.mjs            — patch version bump (runs before each build)
  co-stop-hook.sh          — Claude Code Stop hook script
tests/
  utils.test.ts            — 313 tests for utils.ts (node:test, zero dependencies)
styles.css                 — CSS custom properties for dark/light themes
```

## Milestone Status

| Milestone | Status |
|-----------|--------|
| M1 — Embedded terminal | ✓ Complete |
| M2 — Per-project tmux binding | ✓ Complete |
| M3a — Multi-terminal per project | ✓ Complete |
| M3b — Queue UI + auto-send | ✓ Complete (stage 1: manual queue + stage 2: stop hook + auto-send) |
| Session Manager | ✓ Complete |
| Project Registry | ✓ Complete |
| M4 — Task dispatch | Not started |
| M5 — Periodic summaries | Not started |

## License

GPL-3.0-only
