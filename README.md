# Claude Orchestrator

Run multiple coding-agent sessions side-by-side inside Obsidian. Queue up tasks, let them auto-send when the agent finishes, and manage everything from a single dashboard — without leaving your notes. Works with **Claude Code** and **Codex**, and you pick which one each session runs on.

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
The plugin installs structured start/completion hooks for Claude Code and Codex. A matching `Stop` event must follow the turn start and remain stably idle before the next queued item can be sent. Three modes: **Auto** (send automatically), **Listen** (notify only), or **Manual** (full control).

Auto and explicit **Send next** use the same fail-closed gate. If the running Obsidian plugin is older than `main.js`, a required hook/script is missing, or a turn never produces `Stop`, the session shows **reload required**, **repair required**, or **stale** and nothing is sent. A terminal prompt is useful diagnostic evidence, but is never treated as proof that a turn completed.

### Session Manager dashboard
A sidebar panel showing all your sessions at a glance — grouped by project, with status indicators, queue counts, and activity timestamps. Quick-reply buttons for common responses. Idle detection flags sessions that haven't been active in 24+ hours. Hide sessions you don't need without killing them.

### Two engines, chosen per session
Each session runs on either **Claude Code** or **Codex**. Pick a default globally, override it per project, or change it on an individual session. Both engines' sessions run side by side, and each card shows which engine it is on.

Switching is deliberately conservative. A session that has already run something is never repurposed or killed — a sibling session opens for the other engine and the original is left intact, because the two engines' conversations are separate and cannot be handed over. Pending queue items move only when you say so, and only once. Conversation context does not move; hand that over in your own notes.

The sidebar also shows each engine's remaining allowance, with the source and read time. Codex is read from its own app-server; Claude Code's CLI exposes no usage source, so it honestly reads **Unavailable** rather than showing a made-up number. A missing reading never renders as 0%, and a stale one is labelled stale.

### Flexible project setup
Register any folder as a project — not limited to any particular vault structure. Each project gets its own tmux sessions, task queues, and session notes.

### Configured worker launch
Session Manager can launch a real Claude Code or Codex CLI worker directly in a project's configured working directory. The project settings must explicitly choose **Ask for permissions** or **Bypass permission checks** for each engine; missing or unknown policies fail closed. Workers are tagged in tmux and recorded as session notes so Lighthouse can discover them. A global maximum (default 2) prevents unbounded creation, and repeated requests reuse an existing tagged worker.

The **New Claude Code session** and **New Codex session** actions use the same launch path: after an engine is explicitly selected, the configured CLI starts in the new tmux session. Interactive sessions default to the safe **Ask for permissions** policy when no project worker policy is configured; an explicitly configured policy is still honored. They fail closed when the working directory or binary is unavailable. Reopening or restoring an existing session attaches without starting a second CLI. The separate **Launch worker** action remains the unattended, capacity-limited, tagged-worker mode and still requires an explicit project permission policy.

Claude uses the measured `--dangerously-skip-permissions` flag for bypass mode. Codex uses `--dangerously-bypass-approvals-and-sandbox` plus `--dangerously-bypass-hook-trust`. Bypass mode is intended only for a dedicated, trusted project worktree; credentials are inherited by the CLI process and are never written to notes or logs.

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

The plugin registers the hooks it needs on load — Claude Code's
`UserPromptSubmit`, `Stop`, and `Notification` in
`~/.claude/settings.json`; Codex's `UserPromptSubmit`, `Stop`,
`PermissionRequest`, and `Interrupt` in `~/.codex/hooks.json`. Scripts are
materialized at the stable, vault-independent path
`~/.claude-orchestrator/scripts/`. Existing unrelated hooks, including
`SessionEnd`, are preserved.

Readiness checks the running/disk bundle generation, declared events, exact
script paths and bodies, executable bits, and provider ownership. Session
Manager and plugin settings show the last lifecycle event, signal age, and
the most recent rejection/block reason without recording prompts, tokens, or
agent output. After updating a development build, reload safely with:

```bash
obsidian plugin:reload id=claude-orchestrator vault="Work"
```

Codex requires you to trust a hook script before it will run it, so approve
the prompt the first time (and again if the scripts change with a plugin
update). Do not hand-edit hook paths unless diagnosing a failed automatic
repair; reload the plugin first so it can materialize and register the exact
version it is running.

## Commands

| Command | Description |
|---------|-------------|
| Open terminal for current project | Reveal existing terminal or create one |
| Create new terminal for current project | Create a fresh session and start the selected/default engine |
| Launch worker session for current project | Launch the configured default engine in the project worktree |
| Restore all terminals for current project | Reattach sessions that lost their tab |
| Toggle simple mode | Hide/show queue and history panels |
| Open session manager | Open the dashboard in the left sidebar |

## Contributing

```bash
git clone https://github.com/zhou-ziyan/obsidian-claude-orchestrator.git
cd obsidian-claude-orchestrator
npm install
npm run dev       # watch mode
npm run check     # lint + typecheck + unit tests + tmux e2e
npm run test:e2e:worker  # isolated tmux worker-launch smoke test (no real agent quota)
```

The dual-engine acceptance tests drive the real Claude and Codex CLIs, so
they spend real quota and are opt-in rather than part of `npm run check`:

```bash
CO_E2E_CODEX=1 npm run test:e2e:codex
```

They need `tmux`, both CLIs installed and signed in, and they run fully
isolated — a temporary `CODEX_HOME`, a temporary settings file for Claude,
and a temporary signal directory, so your own config is never touched.

One clipboard test overwrites your real system clipboard (it round-trips CJK
text through `pbcopy`), so it is opt-in too:

```bash
CO_E2E_CLIPBOARD=1 npm run test:e2e
```

Symlink into your vault for development:

```bash
ln -s "$(pwd)" "<vault>/.obsidian/plugins/claude-orchestrator"
```

## License

GPL-3.0-only
