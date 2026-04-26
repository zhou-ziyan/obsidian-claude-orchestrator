# Claude Orchestrator

Run multiple Claude Code sessions side-by-side inside Obsidian. Queue up tasks, let them auto-send when Claude finishes, and manage everything from a single dashboard — without leaving your notes.

<img width="1624" height="1061" alt="image" src="https://github.com/user-attachments/assets/58c1ca3f-4982-45e8-bf35-894341115487" />

## Why?

If you use Claude Code across multiple projects, you've probably dealt with:

- **Context switching** — jumping between terminals to check which session is done
- **Idle time** — Claude finishes a task but you don't notice for minutes
- **Lost context** — forgetting what you asked Claude to do, or what's next in the queue

Claude Orchestrator keeps all your sessions visible, queues your tasks, and auto-sends the next one when Claude is ready. You stay in Obsidian, and Claude stays busy.

## Features

### Embedded terminals with project binding
Open a project note and the terminal auto-attaches to that project's tmux session. Run multiple terminals per project, each with its own persistent session. Terminals follow your Obsidian theme automatically.

### Task queue and history
Line up tasks in a queue below the terminal. When you're ready, send the next one — or let auto-send handle it. Everything you've sent is logged in a history panel with timestamps and completion status. Pin a vault note to any session for quick reference.

### Auto-send on completion
Connect Claude Code's [Stop hook](https://docs.anthropic.com/en/docs/claude-code/hooks) to the plugin. When Claude finishes a task, the plugin detects it and auto-sends the next queued item after a 3-second countdown (cancelable). Three modes: **Auto** (send automatically), **Listen** (notify only), or **Manual** (full control).

### Session Manager dashboard
A sidebar panel showing all your sessions at a glance — grouped by project, with status indicators, queue counts, and activity timestamps. Quick-reply buttons for common responses. Idle detection flags sessions that haven't been active in 24+ hours. Hide sessions you don't need without killing them.

### Flexible project setup
Register any folder as a project — not limited to any particular vault structure. Each project gets its own tmux sessions, task queues, and session notes.

## Installation

### Via BRAT (recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community plugins
2. In BRAT settings, click **Add Beta plugin** and enter: `zhou-ziyan/obsidian-claude-orchestrator`
3. Install the native terminal dependency (BRAT doesn't include this automatically):

```bash
cd "<vault>/.obsidian/plugins/claude-orchestrator" && npm install node-pty
```

Or download and run the full install script (includes error handling and platform checks):

```bash
curl -sLO "https://github.com/zhou-ziyan/obsidian-claude-orchestrator/releases/latest/download/install.sh"
bash install.sh "<vault>"
```

4. Restart Obsidian

### Prerequisites

- **Node.js** >= 18
- **tmux** — `brew install tmux` (macOS) or `sudo apt install tmux` (Ubuntu/Debian)

### Auto-send setup (optional)

To enable auto-send, add the Stop hook to your project's `.claude/settings.json`:

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

## Commands

| Command | Description |
|---------|-------------|
| Open terminal for current project | Reveal existing terminal or create one |
| Create new terminal for current project | Always create a fresh session |
| Restore all terminals for current project | Reattach sessions that lost their tab |
| Toggle simple mode | Hide/show queue and history panels |
| Open session manager | Open the dashboard in the left sidebar |

## Contributing

```bash
git clone https://github.com/zhou-ziyan/obsidian-claude-orchestrator.git
cd obsidian-claude-orchestrator
npm install
npm run dev       # watch mode
npm run check     # lint + typecheck + tests
```

Symlink into your vault for development:

```bash
ln -s "$(pwd)" "<vault>/.obsidian/plugins/claude-orchestrator"
```

## License

GPL-3.0-only
