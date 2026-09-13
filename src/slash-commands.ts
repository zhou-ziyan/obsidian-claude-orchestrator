/**
 * Slash-command autocomplete: built-in Claude Code commands merged with
 * skills discovered on disk.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface SlashCommandEntry {
	command: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandEntry[] = [
	{ command: "/clear", description: "Clear conversation history" },
	{ command: "/compact", description: "Compact conversation to save context" },
	{ command: "/cost", description: "Show token usage and cost" },
	{ command: "/doctor", description: "Check Claude Code health" },
	{ command: "/help", description: "Show available commands" },
	{ command: "/init", description: "Initialize CLAUDE.md in current directory" },
	{ command: "/login", description: "Sign in to your account" },
	{ command: "/logout", description: "Sign out of your account" },
	{ command: "/memory", description: "Edit CLAUDE.md memory files" },
	{ command: "/model", description: "Switch AI model" },
	{ command: "/review", description: "Review a pull request" },
];

export function parseSkillMd(content: string): { name: string; description: string } | null {
	if (!content || !content.startsWith("---")) return null;
	const endIdx = content.indexOf("---", 3);
	if (endIdx === -1) return null;
	const frontmatter = content.slice(3, endIdx);
	let name = "";
	let description = "";
	const lines = frontmatter.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value = line.slice(colonIdx + 1).trim();
		if (value === ">-" || value === ">" || value === "|" || value === "|-") {
			const parts: string[] = [];
			while (i + 1 < lines.length && /^\s/.test(lines[i + 1]!)) {
				i++;
				parts.push(lines[i]!.trim());
			}
			value = parts.join(" ");
		}
		if (key === "name") name = value;
		if (key === "description") {
			const useForIdx = value.indexOf("Use for:");
			description = useForIdx > 0 ? value.slice(0, useForIdx).trim() : value;
		}
	}
	return name ? { name, description } : null;
}

export function filterSlashCommands(input: string, commands?: readonly SlashCommandEntry[]): SlashCommandEntry[] {
	if (!input.startsWith("/")) return [];
	if (input !== input.trimEnd()) return [];
	const prefix = input.toLowerCase();
	const list = commands ?? BUILTIN_SLASH_COMMANDS;
	return list.filter((entry) => entry.command.toLowerCase().startsWith(prefix));
}

export function loadSlashCommands(
	skillDirs: string[],
	builtins: readonly SlashCommandEntry[] = BUILTIN_SLASH_COMMANDS,
): SlashCommandEntry[] {
	const skills: SlashCommandEntry[] = [];

	for (const dir of skillDirs) {
		let entries: string[];
		try { entries = readdirSync(dir); } catch { continue; }
		for (const name of entries) {
			const skillDir = join(dir, name);
			let content: string | undefined;
			for (const fn of ["SKILL.md", "skill.md"]) {
				try { content = readFileSync(join(skillDir, fn), "utf8"); break; } catch { /* try next */ }
			}
			if (!content) continue;
			const parsed = parseSkillMd(content);
			if (parsed) {
				skills.push({ command: `/${parsed.name}`, description: parsed.description });
			}
		}
	}

	return mergeWithBuiltinCommands(skills, builtins);
}

export function mergeWithBuiltinCommands(
	skills: SlashCommandEntry[],
	builtins: readonly SlashCommandEntry[] = BUILTIN_SLASH_COMMANDS,
): SlashCommandEntry[] {
	const merged = new Map<string, SlashCommandEntry>();
	for (const entry of builtins) {
		merged.set(entry.command, entry);
	}
	for (const entry of skills) {
		if (!merged.has(entry.command)) {
			merged.set(entry.command, entry);
		}
	}
	return [...merged.values()].sort((a, b) => a.command.localeCompare(b.command));
}

export type AcKeyAction = "accept" | "close" | "next" | "prev" | null;

export function classifyAcKey(key: string, shiftKey: boolean): AcKeyAction {
	if (key === "ArrowDown") return "next";
	if (key === "ArrowUp") return "prev";
	if (key === "Escape") return "close";
	if ((key === "Enter" || key === "Tab" || key === "ArrowRight") && !shiftKey) return "accept";
	return null;
}
