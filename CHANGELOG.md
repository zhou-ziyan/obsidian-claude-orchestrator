# Changelog

All notable changes to the Claude Orchestrator plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.96] - 2026-04-20

### Added
- **Responsive Session Manager cards**: Cards progressively hide secondary info at narrow sidebar widths — timestamps and previews below 220px, queue badges below 160px, entire meta row below 120px.
- **External queue edit triggers auto-send**: Editing a session note's queue from outside Obsidian (e.g., via SSH/Termius from a phone) now immediately triggers auto-send instead of waiting 5.5 seconds.
- **Quick Reply supports tmux key sequences**: `{C-c}` format sends tmux key names (e.g., Ctrl+C interrupt). Displayed as `^C` in the UI. Default button list now includes `{C-c}`.
- **Manual Active/Inactive project marking**: Projects can be manually marked as inactive via a checkbox in the settings panel. Inactive projects collapse to the bottom of the Session Manager list.
- **Unregister confirmation shows session count**: Unregister button now warns "N active sessions will move to Unmanaged" before confirming.

### Changed
- **Terminal panels open in main editor area**: Attach/Focus operations now open terminals in the center workspace (tab groups for same project, vertical splits for different projects) instead of the right sidebar.
- **Session note settings panel**: Removed redundant checkmark indicator; note path is now a clickable link that opens the session note.
- **All icons replaced with Lucide SVGs**: Unicode emoji/symbols replaced with Obsidian's built-in Lucide icon set via `setIcon()`.

### Fixed
- **Terminal selection row offset**: Disabled tmux status bar (`set-option status off`) which occupied one row and caused xterm/tmux row count mismatch — selection was consistently off by one row.
- **Terminal selection misalignment after resize**: Added synchronous `fitTerminal()` calls at all resize trigger points (ResizeObserver, layout-change, panel drag) to eliminate the stale-dimension window that caused mouse-to-row mapping errors.
- **Terminal not expanding horizontally**: Replaced FitAddon with custom `fitTerminal()` that doesn't subtract 14px for scrollbar (macOS uses overlay scrollbars). Added 300ms delayed re-fit for sidebar animation settle.
- **Restore session layout**: Empty tabs are now reused instead of always creating new splits.
- **Terminal scrolls to bottom on focus**: Switching to a terminal tab or double-clicking an SM card now auto-scrolls to the latest output.
- **Rename UI buttons not hiding**: Fixed rename mode showing original action buttons alongside confirm/cancel.

## [0.0.83] - 2026-04-19

### Added
- **Session note lifecycle management**: Rename syncs tmux session name + note file + frontmatter. Kill offers "Archive" (rename to `archive-<name>.md`) or "Delete" (permanent removal) choices for the session note.
- **Session note auto-association**: Session Manager automatically creates session note files for managed tmux sessions discovered via `tmux ls`.
- **New project stays visible**: Newly registered projects (never had sessions) remain in the main list instead of being immediately relegated to "Inactive projects."

### Changed
- **Pin chip permanently shows session note**: Click opens the session note in the editor. Cannot be unpinned — always points to `sessions/<sessionName>.md`.
- **Queue badge format**: Changed from bare number (`3`) to `Q 3` format.
- **Queue textarea placeholder**: Now shows `Add to queue… / slash for commands / ↑ for history`.
- **UI aligned to design reference**: Font sizes, weights, letter-spacing, button padding, segmented control styling, PTY indicator, queue bar controls, kill confirm area, and card state elements (Send next button, countdown pill) all matched to design spec.

### Fixed
- **History completion not persisting**: Stop signal marking history items as completed was being overwritten by a concurrent disk read. Fixed by skipping the disk update when a terminal view is handling the signal.
- **Terminal fill gaps**: Bottom and right whitespace eliminated by setting `.xterm` to 100% width/height and adding post-spawn fit.
- **Session switch state leaks**: New `SessionLifecycle` coordinator prevents stale data from old sessions appearing after project switches.
- **Session name collisions**: `generateSessionName()` now scans disk for existing note files, not just open tabs.
- **Scroll jump on message send**: Terminal scrolls to bottom before injecting text via `tmux send-keys`.
- **Queue bar height jitter**: Fixed height prevents layout jumps when elements show/hide. Focus indicator uses `visibility: hidden` instead of `display: none`.
- **Queue title alignment between themes**: Fixed Terminal theme's `::before` pseudo-element pushing "Queue" text to center.
- **Running status dot halo clipped**: Status dot moved to card top row as direct flex child to prevent `overflow: hidden` clipping.

## [0.0.55] - 2026-04-19

### Added
- **Dual-theme architecture**: `data-theme` driven system with Terminal (green/monospace/square) and Obsidian (purple/rounded) themes. ~50 CSS custom properties. Settings dropdown for real-time switching.
- **Segmented mode control**: Queue mode toggle replaced with a three-segment control (Manual/Listen/Auto) with semantic color highlighting.
- **Unified button system**: Standardized `.btn` (variant/tone/size) and `.icon-btn` components replacing ad-hoc button classes.
- **Asking state visual feedback**: Ask banner in queue panel, orange terminal border, pulsing SM status dot, and countdown pill for auto-send.
- **Composer improvements**: Grid layout, larger textarea, accent focus ring, autocomplete dropdown with monospace command names.

### Changed
- **Theme names**: `v1` → `terminal`, `v2` → `obsidian` with automatic migration.
- **View header hidden**: Terminal and Session Manager panel headers hidden via CSS to reclaim vertical space.
- **SM card redesign**: Status indicators changed to 7px dots with halo/pulse animations. Meta row uses single-line flex layout.
- **History items compacted**: Smaller font, tighter spacing, hover background, tabular-nums timestamps.

### Removed
- **SM Notes inline editor**: Notes display and editing removed from Session Manager cards. Notes section preserved in session note files.

## [0.0.42] - 2026-04-18

### Added
- **Terminal scroll wheel capture**: Mouse wheel events in the terminal area are now intercepted and routed to xterm scrolling instead of leaking to Obsidian.
- **Slash command autocomplete**: Typing `/` in the queue input shows a dropdown of Claude Code commands. Supports custom skills from `.claude/skills/` directories.
- **Queue input history**: Up/Down arrow keys navigate through previously sent queue items (with timestamp prefix stripped).
- **Page Up/Down terminal scrolling**: Scrolls the terminal viewport instead of being sent as escape sequences to tmux.
- **Pinned note auto-update on file rename**: Session note frontmatter references update automatically when vault files are moved/renamed.

### Fixed
- **Image queue items executed as shell commands**: Items starting with `!` (like `![[image.png]]`) were being interpreted as `! <command>` by Claude Code. Fixed by prepending a space.
- **Session disconnect after reload**: Three-tier recovery: `setState` path fix, reverse project mapping, and automatic unclaimed session recovery via `tmux ls`.

## [0.0.38] - 2026-04-17

### Added
- **Slash command custom skills**: Scans `~/.claude/skills/` and project `.claude/skills/` directories for SKILL.md files. Supports YAML multi-line descriptions.
- **Session rename**: `displayName` field in session note frontmatter. Inline editing in SM card with double-click.
- **Queue history navigation**: Up/Down keys in queue input cycle through previously sent items.
- **Stop hook done vs. asking detection**: Analyzes Claude's last message to distinguish task completion from questions. Drives auto-send (done) vs. notification (asking) behavior.
- **PTY dashboard + idle session highlighting**: PTY usage bar (green/yellow/red), 24h idle session markers.
- **Session card preview**: Shows last queue/history item as italic preview text.
- **Listen mode notifications**: macOS Notification + Glass.aiff sound + Obsidian Notice for listen mode triggers.
- **SM countdown sync**: Send buttons in Session Manager show real-time countdown state.
- **Asking sound alert**: Glass.aiff plays when Claude stops and waits for user input (configurable).
- **Session settings panel**: Per-session settings with session note path display and relink functionality.

### Changed
- **Quick Reply customizable**: Button keys configurable via settings (comma-separated). Default reduced to `1, 2, Y`.
- **Session numbering starts at -1**: First session is `project-1` instead of bare project name, eliminating name/key ambiguity.
- **CSS custom properties refactored**: ~50 hardcoded colors extracted to CSS variables. Theme switching requires only variable overrides.

### Fixed
- **tmux copy-mode send failure**: `send-keys -X cancel` sent before text injection to exit copy-mode.
- **Stop hook status sync**: Quick reply now sets status to running, preventing stale idle state after answering questions.
- **SM card mode colors**: Fixed CSS specificity issue where badge gray was overriding mode-specific colors.
- **Queue header overflow**: Buttons no longer wrap to new line at narrow widths.

## [0.0.16] - 2026-04-16

### Added
- **Project Registry**: Any vault folder can be registered as a project with custom working directory. Automatic migration from `01_Projects/<NN>_<Name>` convention.
- **Project management UI**: Register/edit/delete projects in Session Manager. Folder browser for vault and filesystem paths.
- **PTY budget management**: Pre-spawn check against macOS PTY limit (511). Warning at 90%, block at 100%.
- **Session Manager**: Left sidebar panel with per-project session grouping, status monitoring, Focus/Attach/Kill/Send actions, drag-and-drop reordering, 30s polling + event-driven refresh.
- **Auto-send countdown**: 3-second countdown with cancel button when Claude finishes in Auto mode.
- **History auto-completion**: Queue items automatically marked as completed when Claude finishes.
- **Stop hook signal infrastructure**: Shell script writes JSON signals to `/tmp/co-stop/`, plugin watches and routes to terminal views.
- **Session notes**: Markdown files with frontmatter + History/Queue/Notes sections, auto-created per session.
- **Restore sessions per project**: One-click restore of all detached tmux sessions.

### Changed
- **Simple mode toggle**: Replaces old "queue panel" toggle. Default shows full UI, simple mode hides queue/history.
- **Light theme support**: Automatic dark/light switching following Obsidian theme.

### Fixed
- **Root project session note paths**: Fixed double-slash in paths for vault-root projects.
- **sendNext silent failures**: Added `-l` flag for literal text, absolute tmux path, and error notifications.

## [0.0.1] - 2026-04-14

### Added
- **Embedded terminal** (M1): xterm.js + node-pty terminal in the right sidebar with cursor blink, UTF-8 locale, and auto-restart on exit.
- **Project-bound tmux** (M2): Automatic tmux session binding based on vault project path. Multiple panels can coexist for different projects.
- **Multi-session support** (M3a): Multiple terminal sessions per project (`project-1`, `project-2`, etc.) with independent tmux sessions.
- **Focus dimming**: Non-focused terminal panels show a semi-transparent overlay. Click to switch focus.
- **Resize guard**: Minimum width check prevents terminal from collapsing during Obsidian layout transitions.
