#!/usr/bin/env bash
# One-way sync of Zoey's Claude config into Codex's config, so both engines
# start from the same global prompt and the same skills.
#
# Measured against codex-cli 0.154.0-alpha.6.2 on 2026-09-16 — every rule below
# is an observation, not an assumption (full evidence in the vault note
# 15_Claude_Orchestrator_Task_EngineSync):
#
#   * Codex loads skills from $CODEX_HOME/skills, ~/.agents/skills,
#     <project>/.codex/skills and <project>/.agents/skills. It does NOT read
#     <project>/.claude/skills — which is exactly where the vault keeps its
#     skills, so without this sync Codex sees none of them.
#   * A skill DIRECTORY may be a symlink and still loads. A SKILL.md FILE that
#     is a symlink is dropped, with no error anywhere. Hence: link directories,
#     never files, and refuse to publish a skill whose SKILL.md is a link
#     rather than shipping something Codex will quietly ignore.
#   * Codex has no /slash surface for skills. Once synced they are reachable in
#     the TUI as `$skill-name`, or by matching the description in plain text.
#
# Anything this script cannot fix is a hard error. It never skips silently —
# that is the failure mode it exists to prevent.
#
# Not a hook script: the co-*.sh name pattern in this directory is reserved for
# scripts that get bundled into the plugin by gen-hook-scripts.mjs.

set -eu

SELF="$(basename "$0")"

usage() {
	cat <<USAGE
usage: $SELF [--vault PATH] [--dry-run] [--copy]

Syncs, one way, Claude -> Codex:
  \$CO_SYNC_CLAUDE_MD (default ~/.claude/CLAUDE.md)  ->  \$CODEX_HOME/AGENTS.md
  <vault>/.claude/skills/*                          ->  \$CODEX_HOME/skills/*

Options:
  --vault PATH   Obsidian vault root. Falls back to \$CO_SYNC_VAULT.
  --dry-run      Print the plan, change nothing. Still fails on a bad source.
  --copy         Copy skill directories instead of symlinking them. Use when
                 the vault may be offline (iCloud eviction) — at the cost of
                 having to re-run this after every skill edit.
  -h, --help     This text.

Environment:
  CO_SYNC_VAULT      vault root, when --vault is not given
  CO_SYNC_CLAUDE_MD  source prompt file
  CODEX_HOME         Codex config root (default ~/.codex)
USAGE
}

die() { printf '%s: error: %s\n' "$SELF" "$*" >&2; exit 1; }

DRY_RUN=0
MODE=link
VAULT="${CO_SYNC_VAULT:-}"

while [ $# -gt 0 ]; do
	case "$1" in
		--vault) [ $# -ge 2 ] || die "--vault needs a path"; VAULT="$2"; shift 2 ;;
		--vault=*) VAULT="${1#--vault=}"; shift ;;
		--dry-run) DRY_RUN=1; shift ;;
		--copy) MODE=copy; shift ;;
		-h|--help) usage; exit 0 ;;
		*) usage >&2; die "unknown argument: $1" ;;
	esac
done

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CLAUDE_MD="${CO_SYNC_CLAUDE_MD:-$HOME/.claude/CLAUDE.md}"
AGENTS_MD="$CODEX_HOME/AGENTS.md"
SKILLS_DEST="$CODEX_HOME/skills"
# Names this script published, so a later run can tell its own output apart
# from skills Codex or `skill-installer` put there. Kept outside skills/ so the
# skills root holds nothing but skills.
MANIFEST="$CODEX_HOME/.co-sync-manifest"

# --- resolve and validate sources before writing anything ------------------

[ -n "$VAULT" ] || die "no vault given; pass --vault PATH or set CO_SYNC_VAULT"
[ -d "$VAULT" ] || die "vault not found: $VAULT"
SKILLS_SRC="$VAULT/.claude/skills"
[ -f "$CLAUDE_MD" ] || die "source prompt not found: $CLAUDE_MD"
[ -d "$SKILLS_SRC" ] || die "vault skills directory not found: $SKILLS_SRC"

SKILLS_SRC_REAL="$(cd "$SKILLS_SRC" && pwd -P)"

# Every source problem is collected first, so one run reports all of them
# instead of making the user re-run to discover the next one.
problems=""
names=""
for entry in "$SKILLS_SRC"/*; do
	[ -e "$entry" ] || continue
	name="$(basename "$entry")"
	case "$name" in .*) continue ;; esac
	if [ ! -d "$entry" ]; then
		problems="$problems\n  $name: not a directory"
		continue
	fi
	if [ -L "$entry/SKILL.md" ]; then
		# Codex drops these without a word; publishing one would look like a
		# success and behave like the skill does not exist.
		problems="$problems\n  $name: SKILL.md is a symlink — Codex silently ignores skills like this; replace it with a real file"
		continue
	fi
	if [ ! -f "$entry/SKILL.md" ]; then
		problems="$problems\n  $name: no SKILL.md"
		continue
	fi
	names="$names$name
"
done

if [ -n "$problems" ]; then
	# shellcheck disable=SC2059
	printf "$SELF: error: unusable skills in $SKILLS_SRC:$problems\n" >&2
	exit 1
fi

[ -n "$names" ] || die "no skills found in $SKILLS_SRC"

managed=""
[ -f "$MANIFEST" ] && managed="$(cat "$MANIFEST")"
is_managed() {
	printf '%s\n' "$managed" | grep -qxF "$1"
}

# A destination that exists but was not published by this script belongs to
# somebody else — refuse rather than overwrite it.
collisions=""
for name in $names; do
	dest="$SKILLS_DEST/$name"
	[ -e "$dest" ] || [ -L "$dest" ] || continue
	is_managed "$name" && continue
	if [ -L "$dest" ]; then
		target="$(readlink "$dest")"
		[ "$target" = "$SKILLS_SRC_REAL/$name" ] && continue
	fi
	collisions="$collisions\n  $name: $dest already exists and was not created by $SELF"
done

if [ -n "$collisions" ]; then
	# shellcheck disable=SC2059
	printf "$SELF: error: refusing to overwrite:$collisions\n" >&2
	exit 1
fi

# --- plan ------------------------------------------------------------------

changes=0
say() { changes=$((changes + 1)); printf '%s\n' "$*"; }
run() { [ "$DRY_RUN" -eq 1 ] || "$@"; }

if [ ! -f "$AGENTS_MD" ] || ! cmp -s "$CLAUDE_MD" "$AGENTS_MD"; then
	say "copy   AGENTS.md  <- $CLAUDE_MD"
	run mkdir -p "$CODEX_HOME"
	run cp "$CLAUDE_MD" "$AGENTS_MD"
fi

for name in $names; do
	# A skill that is itself a symlink in the vault resolves to its real home,
	# so the published link never depends on a chain staying intact.
	src="$(cd "$SKILLS_SRC/$name" && pwd -P)"
	dest="$SKILLS_DEST/$name"
	if [ "$MODE" = link ]; then
		if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
			continue
		fi
		say "link   $name -> $src"
		run mkdir -p "$SKILLS_DEST"
		run rm -rf "$dest"
		run ln -s "$src" "$dest"
	else
		if [ ! -L "$dest" ] && [ -d "$dest" ] && diff -r "$src" "$dest" >/dev/null 2>&1; then
			continue
		fi
		say "copy   $name <- $src"
		run mkdir -p "$SKILLS_DEST"
		run rm -rf "$dest"
		run cp -R "$src" "$dest"
	fi
done

# Skills this script published that are gone from the vault. Only names in the
# manifest are eligible, so nothing installed by other means is ever removed.
for name in $managed; do
	[ -n "$name" ] || continue
	printf '%s\n' "$names" | grep -qxF "$name" && continue
	dest="$SKILLS_DEST/$name"
	[ -e "$dest" ] || [ -L "$dest" ] || continue
	say "prune  $name (no longer in $SKILLS_SRC)"
	run rm -rf "$dest"
done

if [ "$DRY_RUN" -eq 0 ]; then
	mkdir -p "$CODEX_HOME"
	printf '%s' "$names" > "$MANIFEST"
fi

if [ "$changes" -eq 0 ]; then
	printf '%s: up to date (%s skills)\n' "$SELF" "$(printf '%s' "$names" | grep -c .)"
elif [ "$DRY_RUN" -eq 1 ]; then
	printf '%s: dry run — %s change(s) planned, nothing written\n' "$SELF" "$changes"
else
	printf '%s: synced — %s change(s)\n' "$SELF" "$changes"
fi
