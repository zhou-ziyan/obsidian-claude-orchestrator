/**
 * Session note model: the markdown file that mirrors one tmux session
 * (frontmatter status + Notes/History/Queue sections), with fidelity
 * fields so plugin saves never destroy user- or agent-added content.
 */
import { generateSessionName, normalizeVaultFolder } from "./projects.ts";
import type { ProjectRegistry } from "./projects.ts";

/**
 * Return a compact timestamp string for stamping queue items.
 * Format: YYYY-MM-DD HH:MM
 */
export function nowStamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type SessionStatus = "idle" | "running" | "waiting_for_user" | "error" | "stale";

export type QueueMode = "manual" | "listen" | "auto";

export const QUEUE_MODES: readonly QueueMode[] = ["manual", "listen", "auto"] as const;
export const DEFAULT_QUEUE_MODE: QueueMode = "auto";

export function queueModeLabel(mode: QueueMode): string {
	switch (mode) {
		case "manual": return "Manual";
		case "listen": return "Listen";
		case "auto": return "Auto";
	}
}

/**
 * Reverse-map a vault file path to the tmux session it is the note for.
 * Returns null for archives, non-markdown files, nested paths, and paths
 * outside every registered project's sessions directory.
 */
export function sessionNameFromNotePath(
	path: string,
	projects: ProjectRegistry,
): string | null {
	if (!path.endsWith(".md")) return null;
	for (const config of Object.values(projects)) {
		const dir = sessionDirPath(config.vaultFolder) + "/";
		if (!path.startsWith(dir)) continue;
		const rest = path.slice(dir.length);
		if (rest.includes("/")) continue;
		if (rest.startsWith("archive-")) continue;
		return rest.slice(0, -3);
	}
	return null;
}

function isQueueMode(s: unknown): s is QueueMode {
	return s === "manual" || s === "listen" || s === "auto";
}

/** Resolve the mode to stamp on a session note at creation time. Defaults
 * never participate when reading an existing note; its frontmatter remains
 * the source of truth. */
export function newSessionQueueMode(
	projectMode: unknown,
	globalMode: unknown,
): QueueMode {
	if (isQueueMode(projectMode)) return projectMode;
	if (isQueueMode(globalMode)) return globalMode;
	return DEFAULT_QUEUE_MODE;
}

export interface HistoryItem {
	text: string;
	completed: boolean;
}

export interface ExtraSection {
	heading: string;
	body: string;
}

export interface SessionNote {
	session: string;
	status: SessionStatus;
	queueMode: QueueMode;
	displayName: string;
	summary: string;
	/** Engine (provider) driving this session, e.g. "claude". Empty means
	 * "not recorded" — see resolveEngineRef: absent defaults to Claude,
	 * because every note written before dual-engine support was a Claude
	 * session. Stored separately from `model` so switching model never
	 * implies switching engine. */
	engine: string;
	/** Model name passed to the engine. Free-form: never validated against
	 * a hard-coded list, so new models need no plugin change. */
	model: string;
	notes: string;
	history: HistoryItem[];
	queue: string[];
	// Fidelity fields — parse sets them only when the source deviates from
	// the canonical template, and serialize replays them verbatim, so user-
	// or agent-added content is never destroyed by a plugin save.
	extraFrontmatter?: string[];
	preamble?: string;
	extraSections?: ExtraSection[];
	sectionSeq?: ("notes" | "history" | "queue" | number)[];
}

/**
 * Vault-relative path for a session note.
 * `vaultFolder` is the project's vault-relative folder path.
 * Empty string means vault root.
 */

/**
 * Vault-relative path for a session note.
 * `vaultFolder` is the project's vault-relative folder path.
 * Empty string means vault root.
 */
export function sessionDirPath(vaultFolder: string): string {
	const normalized = normalizeVaultFolder(vaultFolder);
	return normalized ? `${normalized}/sessions` : "sessions";
}

export function sessionNotePath(
	vaultFolder: string,
	sessionName: string,
): string {
	return `${sessionDirPath(vaultFolder)}/${sessionName}.md`;
}

export function archiveSessionNotePath(
	vaultFolder: string,
	sessionName: string,
): string {
	return `${sessionDirPath(vaultFolder)}/archive-${sessionName}.md`;
}

export function renamedSessionNotePath(
	vaultFolder: string,
	oldSessionName: string,
	newSessionName: string,
): { oldPath: string; newPath: string } {
	const dir = sessionDirPath(vaultFolder);
	return {
		oldPath: `${dir}/${oldSessionName}.md`,
		newPath: `${dir}/${newSessionName}.md`,
	};
}

/**
 * Create default markdown content for a new session note.
 */

/**
 * Create default markdown content for a new session note.
 */
export function createDefaultSessionNote(
	sessionName: string,
	queueMode: QueueMode = DEFAULT_QUEUE_MODE,
	engine = "",
	model = "",
): string {
	return [
		"---",
		`session: ${sessionName}`,
		"status: idle",
		`queueMode: ${queueMode}`,
		...(engine ? [`engine: ${engine}`] : []),
		...(model ? [`model: ${model}`] : []),
		"---",
		"",
		"## Notes",
		"",
		"## History",
		"",
		"## Queue",
		"",
	].join("\n");
}

export function restoreSessionNote(
	archive: SessionNote,
	newSessionName: string,
	queueMode: QueueMode = DEFAULT_QUEUE_MODE,
): SessionNote {
	return {
		session: newSessionName,
		status: "idle",
		queueMode,
		displayName: "",
		summary: "",
		engine: archive.engine,
		model: archive.model,
		notes: archive.notes,
		history: archive.history.map((h) => ({ ...h })),
		queue: [...archive.queue],
		...(archive.extraFrontmatter ? { extraFrontmatter: [...archive.extraFrontmatter] } : {}),
		...(archive.preamble ? { preamble: archive.preamble } : {}),
		...(archive.extraSections ? { extraSections: archive.extraSections.map((s) => ({ ...s })) } : {}),
		...(archive.sectionSeq ? { sectionSeq: [...archive.sectionSeq] } : {}),
	};
}

export function computeRelinkTarget(
	oldSessionName: string,
	project: string,
	vaultFolder: string,
	existingNames: Set<string>,
): { oldSessionName: string; newSessionName: string; notePath: string; dirPath: string } {
	const newSessionName = generateSessionName(project, existingNames);
	return {
		oldSessionName,
		newSessionName,
		notePath: sessionNotePath(vaultFolder, newSessionName),
		dirPath: sessionDirPath(vaultFolder),
	};
}

/**
 * Parse a session note markdown string into a structured SessionNote.
 */

/**
 * Parse a session note markdown string into a structured SessionNote.
 */
export function parseSessionNote(
	markdown: string,
	fallbackSession: string = "",
): SessionNote {
	const note: SessionNote = {
		session: fallbackSession,
		status: "idle",
		queueMode: "manual",
		displayName: "",
		summary: "",
		engine: "",
		model: "",
		notes: "",
		history: [],
		queue: [],
	};

	const lines = markdown.split("\n");
	let i = 0;

	const KNOWN_FM_KEYS = new Set(["session", "status", "queueMode", "displayName", "summary", "engine", "model"]);
	// Plugin-written keys from removed features — consumed and dropped on
	// save (deliberate migration), unlike user keys which are preserved.
	const LEGACY_STRIP_FM_KEYS = new Set(["pinnedNote"]);
	const extraFrontmatter: string[] = [];

	// Parse frontmatter
	if (lines[i]?.trim() === "---") {
		i++;
		while (i < lines.length && lines[i]?.trim() !== "---") {
			const line = lines[i]!.trim();
			const colonIdx = line.indexOf(":");
			const key = colonIdx !== -1 ? line.slice(0, colonIdx).trim() : "";
			if (KNOWN_FM_KEYS.has(key)) {
				const value = line.slice(colonIdx + 1).trim();
				if (key === "session") note.session = value;
				if (key === "status" && isSessionStatus(value))
					note.status = value;
				if (key === "queueMode" && isQueueMode(value))
					note.queueMode = value;
				if (key === "displayName" && value)
					note.displayName = value;
				if (key === "summary" && value)
					note.summary = value;
				if (key === "engine" && value)
					note.engine = value;
				if (key === "model" && value)
					note.model = value;
			} else if (line !== "" && !LEGACY_STRIP_FM_KEYS.has(key)) {
				// Unknown frontmatter (tags, aliases, agent-written keys, …) —
				// preserve verbatim so a plugin save never destroys it.
				extraFrontmatter.push(lines[i]!);
			}
			i++;
		}
		if (i < lines.length) i++; // skip closing ---
	}

	// Parse body sections. Everything the plugin doesn't own (content before
	// the first heading, unknown ## sections) is captured raw and replayed
	// in place by serializeSessionNote.
	let currentSection: "preamble" | "notes" | "history" | "queue" | "extra" = "preamble";
	const notesLines: string[] = [];
	const preambleLines: string[] = [];
	const extraSections: ExtraSection[] = [];
	const sectionSeq: ("notes" | "history" | "queue" | number)[] = [];
	const seenKnown = new Set<string>();
	let extraLines: string[] = [];

	const trimBlankEdges = (arr: string[]): string[] => {
		const copy = [...arr];
		while (copy.length > 0 && copy[0]!.trim() === "") copy.shift();
		while (copy.length > 0 && copy[copy.length - 1]!.trim() === "") copy.pop();
		return copy;
	};

	const closeExtra = (): void => {
		if (currentSection === "extra" && extraSections.length > 0) {
			extraSections[extraSections.length - 1]!.body = trimBlankEdges(extraLines).join("\n");
		}
		extraLines = [];
	};

	const enterKnown = (kind: "notes" | "history" | "queue"): void => {
		closeExtra();
		if (!seenKnown.has(kind)) {
			seenKnown.add(kind);
			sectionSeq.push(kind);
		}
		currentSection = kind;
	};

	while (i < lines.length) {
		const line = lines[i]!;
		const trimmed = line.trim();

		if (trimmed.toLowerCase() === "## notes") {
			enterKnown("notes");
			i++;
			continue;
		}
		if (trimmed.toLowerCase() === "## history") {
			enterKnown("history");
			i++;
			continue;
		}
		if (trimmed.toLowerCase() === "## queue") {
			enterKnown("queue");
			i++;
			continue;
		}
		// Unknown heading — capture the section verbatim.
		if (trimmed.startsWith("## ")) {
			closeExtra();
			extraSections.push({ heading: trimmed, body: "" });
			sectionSeq.push(extraSections.length - 1);
			currentSection = "extra";
			i++;
			continue;
		}

		if (currentSection === "preamble") {
			preambleLines.push(line);
			i++;
			continue;
		}

		if (currentSection === "extra") {
			extraLines.push(line);
			i++;
			continue;
		}

		if (currentSection === "notes") {
			notesLines.push(line);
			i++;
			continue;
		}

		// Items start with "- " (optionally with checkbox for history).
		// Continuation lines are indented (start with spaces/tabs) and
		// belong to the previous item.
		if ((currentSection === "history" || currentSection === "queue") && trimmed.startsWith("- ")) {
			const content = trimmed.slice(2);
			// Collect continuation lines: any line starting with 2+ spaces or tab
			// belongs to this item. Blank lines (empty or whitespace-only) are
			// preserved if followed by an indented continuation line.
			const textLines = [stripLeadingCheckboxes(content)];
			while (i + 1 < lines.length) {
				const nextRaw = lines[i + 1]!;
				if (nextRaw.startsWith("  ") || nextRaw.startsWith("\t")) {
					textLines.push(nextRaw.trim());
					i++;
				} else if (nextRaw.trim() === "") {
					// Blank line: look ahead to see if an indented line follows
					let peek = i + 2;
					while (peek < lines.length && lines[peek]!.trim() === "") peek++;
					if (peek < lines.length && (lines[peek]!.startsWith("  ") || lines[peek]!.startsWith("\t"))) {
						textLines.push("");
						i++;
					} else {
						break;
					}
				} else {
					break;
				}
			}
			const fullText = textLines.join("\n");
			if (currentSection === "history") {
				const checkMatch = content.match(/^\[([ xX])\] /);
				note.history.push({
					text: fullText,
					completed: checkMatch ? checkMatch[1] !== " " : false,
				});
			} else {
				note.queue.push(fullText);
			}
		}

		i++;
	}

	closeExtra();

	// Trim leading/trailing blank lines from notes
	while (notesLines.length > 0 && notesLines[0]!.trim() === "") notesLines.shift();
	while (notesLines.length > 0 && notesLines[notesLines.length - 1]!.trim() === "") notesLines.pop();
	note.notes = notesLines.join("\n");

	// Fidelity fields only when the source deviates from the canonical shape.
	if (extraFrontmatter.length > 0) note.extraFrontmatter = extraFrontmatter;
	const preamble = trimBlankEdges(preambleLines).join("\n");
	if (preamble) note.preamble = preamble;
	if (extraSections.length > 0) {
		note.extraSections = extraSections;
		note.sectionSeq = sectionSeq;
	} else if (sectionSeq.length > 0 && sectionSeq.join(",") !== "notes,history,queue") {
		note.sectionSeq = sectionSeq;
	}

	return note;
}

function stripLeadingCheckboxes(content: string): string {
	// Strip one or more leading "[ ] " / "[x] " / "[X] " checkbox prefixes.
	return content.replace(/^(\[[ xX]\] )+/, "");
}

function isSessionStatus(s: string): s is SessionStatus {
	return s === "idle" || s === "running" || s === "waiting_for_user" || s === "error" || s === "stale";
}

/**
 * Serialize a SessionNote back to markdown.
 */

/**
 * Serialize a SessionNote back to markdown.
 */
export function serializeSessionNote(note: SessionNote): string {
	const lines: string[] = [
		"---",
		`session: ${note.session}`,
		`status: ${note.status}`,
		`queueMode: ${note.queueMode}`,
	];
	if (note.displayName) lines.push(`displayName: ${note.displayName}`);
	if (note.summary) lines.push(`summary: ${note.summary}`);
	if (note.engine) lines.push(`engine: ${note.engine}`);
	if (note.model) lines.push(`model: ${note.model}`);
	if (note.extraFrontmatter) lines.push(...note.extraFrontmatter);
	lines.push("---");

	if (note.preamble) lines.push("", note.preamble);

	// Emit sections in source order; known sections missing from the
	// sequence (or when no sequence was recorded) follow canonical order.
	const seq: ("notes" | "history" | "queue" | number)[] = [...(note.sectionSeq ?? [])];
	for (const kind of ["notes", "history", "queue"] as const) {
		if (!seq.includes(kind)) seq.push(kind);
	}

	for (const kind of seq) {
		if (kind === "notes") {
			lines.push("", "## Notes");
			if (note.notes) lines.push(note.notes);
		} else if (kind === "history") {
			lines.push("", "## History");
			for (const item of note.history) {
				const mark = item.completed ? "x" : " ";
				const itemLines = item.text.split("\n");
				lines.push(`- [${mark}] ${itemLines[0]}`);
				for (let j = 1; j < itemLines.length; j++) {
					lines.push(`  ${itemLines[j]}`);
				}
			}
		} else if (kind === "queue") {
			lines.push("", "## Queue");
			for (const item of note.queue) {
				const itemLines = item.split("\n");
				lines.push(`- ${itemLines[0]}`);
				for (let j = 1; j < itemLines.length; j++) {
					lines.push(`  ${itemLines[j]}`);
				}
			}
		} else {
			const extra = note.extraSections?.[kind];
			if (extra) {
				lines.push("", extra.heading);
				if (extra.body) lines.push(extra.body);
			}
		}
	}

	lines.push("");
	return lines.join("\n");
}

const TIMESTAMP_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /;

export function stripTimestamp(text: string): string {
	return text.replace(TIMESTAMP_PREFIX_RE, "");
}

const PREVIEW_SKIP_RE = /^(按照\s|按\s\S+\s执行|##+ |---\s*$)/;

export function extractSessionPreview(note: SessionNote): string | null {
	if (note.summary) return note.summary;

	const source = note.queue.length > 0
		? note.queue[note.queue.length - 1]!
		: note.history.length > 0
			? note.history[note.history.length - 1]!.text
			: null;
	if (!source) return null;
	const stripped = source.replace(TIMESTAMP_PREFIX_RE, "");
	const lines = stripped.split("\n");
	const meaningful = lines.find((l) => l.trim().length > 0 && !PREVIEW_SKIP_RE.test(l.trim()));
	return meaningful?.trim() ?? lines[0]!;
}

/**
 * Format a "YYYY-MM-DD HH:MM" timestamp as relative time.
 * Accepts an optional `now` parameter for testability.
 */

/**
 * Format a "YYYY-MM-DD HH:MM" timestamp as relative time.
 * Accepts an optional `now` parameter for testability.
 */
export function formatRelativeTime(stamp: string, now?: Date): string {
	const [datePart, timePart] = stamp.split(" ");
	if (!datePart || !timePart) return stamp;
	const dateParts = datePart.split("-").map(Number);
	const timeParts = timePart.split(":").map(Number);
	const y = dateParts[0] ?? 0, mo = dateParts[1] ?? 1, d = dateParts[2] ?? 1;
	const h = timeParts[0] ?? 0, mi = timeParts[1] ?? 0;
	const then = new Date(y, mo - 1, d, h, mi);
	const ref = now ?? new Date();
	const diffMs = ref.getTime() - then.getTime();
	if (diffMs < 0) return stamp;
	const diffMin = Math.floor(diffMs / 60_000);
	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	return `${diffDay}d ago`;
}

/**
 * Minimum height (px) for the History panel's content area when resized.
 * Sized to show exactly one history item cleanly:
 *   item row = ceil(12px font * 1.4 line-height) + 4px padding = 21px
 *   content padding = 4px top + 4px bottom = 8px
 *   total = 29px
 */

/**
 * Copy a history item's text into the queue array, appending a fresh
 * timestamp. Strips any existing timestamp prefix so it doesn't double up.
 *
 * Returns the index where the item was inserted.
 */
export function copyHistoryItemToQueue(text: string, queue: string[]): number {
	// Strip existing timestamp prefix "[YYYY-MM-DD HH:MM] " if present
	const body = text.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /, "");
	const stamped = `[${nowStamp()}] ${body}`;
	return queue.push(stamped) - 1;
}

export interface QueueItemSegment {
	type: "text" | "image";
	content: string;
}

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|svg|webp|bmp|avif)$/i;

const QUEUE_IMAGE_RE = /!\[\[([^\]]+)]]|!\[(?:[^\]]*)\]\(([^)]+)\)/g;

export function parseQueueItemSegments(text: string): QueueItemSegment[] {
	if (!text) return [];
	const segments: QueueItemSegment[] = [];
	let lastIndex = 0;

	for (const match of text.matchAll(QUEUE_IMAGE_RE)) {
		const ref = match[1] ?? match[2] ?? "";
		if (!IMAGE_EXTS.test(ref)) continue;

		if (match.index > lastIndex) {
			segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
		}
		segments.push({ type: "image", content: ref });
		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < text.length) {
		segments.push({ type: "text", content: text.slice(lastIndex) });
	}

	return segments;
}

const ITEM_TS_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] /;

export function extractTimestamp(text: string): { stamp: string | null; body: string } {
	const m = text.match(ITEM_TS_RE);
	if (m && m[1]) {
		const timeOnly = m[1].split(" ")[1] ?? m[1];
		return { stamp: timeOnly, body: text.slice(m[0]?.length ?? 0) };
	}
	return { stamp: null, body: text };
}

const ACTIVITY_TS_RE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/;

export function findLastActivityTimestamp(
	historyTexts: string[],
	queueTexts: string[],
): string | null {
	const allItems = [...historyTexts, ...queueTexts];
	for (let i = allItems.length - 1; i >= 0; i--) {
		const m = allItems[i]?.match(ACTIVITY_TS_RE);
		if (m?.[1]) return m[1];
	}
	return null;
}

export function summarizeSessionNote(note: SessionNote): {
	queueCount: number;
	lastActivity: string | null;
	preview: string | null;
	displayName: string | null;
	status: SessionStatus;
	queueMode: QueueMode;
	engine: string | null;
	model: string | null;
} {
	return {
		queueCount: note.queue.length,
		lastActivity: findLastActivityTimestamp(
			note.history.map((h) => h.text),
			note.queue,
		),
		preview: extractSessionPreview(note),
		displayName: note.displayName || null,
		status: note.status,
		queueMode: note.queueMode,
		engine: note.engine || null,
		model: note.model || null,
	};
}
