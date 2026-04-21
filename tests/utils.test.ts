import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	generateSessionName,
	resolveProjectFromPath,
	normalizeViewState,
	parseTmuxSessionsForProject,
	sessionNotePath,
	createDefaultSessionNote,
	parseSessionNote,
	serializeSessionNote,
	parseAllTmuxSessions,
	projectFromSessionName,
	groupSessionsByProject,
	restorableSessionNames,
	nowStamp,
	formatRelativeTime,
	migrateSettings,
	findTmuxBinary,
	TMUX_SEARCH_PATHS,
	HISTORY_ITEM_MIN_HEIGHT,
	copyHistoryItemToQueue,
	shouldAutoSendAfterEdit,
	validateProjectKey,
	addProject,
	updateProjectConfig,
	removeProject,
	normalizeVaultFolder,
	computeDisplayText,
	sessionDirPath,
	QUICK_REPLY_KEYS,
	buildQuickReplyTmuxArgs,
	quickReplyLabel,
	cancelCopyModeArgs,
	nextQueueMode,
	queueModeLabel,
	queueModeTooltip,
	QUEUE_MODES,
	parsePtyMax,
	ptyLevel,
	PTY_THRESHOLD_WARNING,
	PTY_THRESHOLD_CRITICAL,
	isSessionIdle,
	IDLE_THRESHOLD_MS,
	parseStopSignal,
	STOP_SIGNAL_DIR,
	stopSignalFileName,
	getPtyStatus,
	ptyStatusMessage,
	parsePtyUsed,
	PTY_WARNING_THRESHOLD,
	PTY_DEFAULT_MAX,
	extractSessionPreview,
	bumpPatchVersion,
	parseQueueItemSegments,
	classifyStopReason,
	extractLastAssistantText,
	autoSendAction,
	AUTO_SEND_COUNTDOWN_MS,
	ensureStopHookConfig,
	parseQuickReplyKeys,
	SLASH_COMMANDS,
	filterSlashCommands,
	applySortOrder,
	parseSkillMd,
	BUILTIN_SLASH_COMMANDS,
	stripTimestamp,
	handleTerminalScrollKey,
	wheelDeltaToLines,
	WHEEL_LINES_PER_PAGE,
	classifyAcKey,
	allSessionNotePaths,
	escapeLeadingBang,
	pickRecoverySession,
	sessionStatusDisplay,
	terminalTheme,
	migrateThemeName,
	collectNoteNamesFromFiles,
	SessionLifecycle,
	sessionsMissingNotes,
	archiveSessionNotePath,
	renamedSessionNotePath,
	unregisterConfirmText,
} from "../src/utils.ts";
import type { ProjectRegistry, SessionNote, SlashCommandEntry } from "../src/utils.ts";

const TEST_PROJECTS: ProjectRegistry = {
	"15_Claude_Orchestrator": { vaultFolder: "01_Projects/15_Claude_Orchestrator" },
	"14_Mobile_Claude_Code": { vaultFolder: "01_Projects/14_Mobile_Claude_Code" },
};

// --- generateSessionName ---

describe("generateSessionName", () => {
	it("returns -1 suffix when nothing exists", () => {
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", new Set()),
			"15_Claude_Orchestrator-1",
		);
	});

	it("returns -1 when other projects exist but not this one", () => {
		const existing = new Set(["14_Mobile_Claude_Code"]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-1",
		);
	});

	it("returns -2 when -1 is taken", () => {
		const existing = new Set(["15_Claude_Orchestrator-1"]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-2",
		);
	});

	it("returns -3 when -1 and -2 are taken", () => {
		const existing = new Set([
			"15_Claude_Orchestrator-1",
			"15_Claude_Orchestrator-2",
		]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-3",
		);
	});

	it("fills gaps (-1 + -3 taken, returns -2)", () => {
		const existing = new Set([
			"15_Claude_Orchestrator-1",
			"15_Claude_Orchestrator-3",
		]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-2",
		);
	});

	it("handles many existing sessions", () => {
		const existing = new Set<string>();
		for (let i = 1; i <= 11; i++) {
			existing.add(`15_Claude_Orchestrator-${i}`);
		}
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-12",
		);
	});

	it("skips legacy bare name when taken", () => {
		const existing = new Set(["15_Claude_Orchestrator"]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-1",
		);
	});

	it("skips legacy bare name and finds next gap", () => {
		const existing = new Set([
			"15_Claude_Orchestrator",
			"15_Claude_Orchestrator-1",
		]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-2",
		);
	});
});

// --- collectNoteNamesFromFiles ---

describe("collectNoteNamesFromFiles", () => {
	it("returns empty set for empty list", () => {
		assert.deepEqual(collectNoteNamesFromFiles([]), new Set());
	});

	it("strips .md extension from filenames", () => {
		const result = collectNoteNamesFromFiles([
			"15_Claude_Orchestrator-1.md",
			"15_Claude_Orchestrator-2.md",
		]);
		assert.deepEqual(
			result,
			new Set(["15_Claude_Orchestrator-1", "15_Claude_Orchestrator-2"]),
		);
	});

	it("ignores non-.md files", () => {
		const result = collectNoteNamesFromFiles([
			"15_Claude_Orchestrator-1.md",
			".DS_Store",
			"notes.txt",
		]);
		assert.deepEqual(
			result,
			new Set(["15_Claude_Orchestrator-1"]),
		);
	});

	it("handles bare project name note", () => {
		const result = collectNoteNamesFromFiles(["15_Claude_Orchestrator.md"]);
		assert.deepEqual(
			result,
			new Set(["15_Claude_Orchestrator"]),
		);
	});
});

// --- generateSessionName with disk note dedup ---

describe("generateSessionName with disk note names", () => {
	it("skips numbers used by disk notes even when no tabs are open", () => {
		const diskNotes = collectNoteNamesFromFiles([
			"15_Claude_Orchestrator-1.md",
			"15_Claude_Orchestrator-2.md",
		]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", diskNotes),
			"15_Claude_Orchestrator-3",
		);
	});

	it("skips numbers used by both tabs and disk notes", () => {
		const openTabs = new Set(["15_Claude_Orchestrator-1"]);
		const diskNotes = collectNoteNamesFromFiles([
			"15_Claude_Orchestrator-2.md",
		]);
		const merged = new Set([...openTabs, ...diskNotes]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", merged),
			"15_Claude_Orchestrator-3",
		);
	});

	it("fills gap between disk notes", () => {
		const diskNotes = collectNoteNamesFromFiles([
			"15_Claude_Orchestrator-1.md",
			"15_Claude_Orchestrator-3.md",
		]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", diskNotes),
			"15_Claude_Orchestrator-2",
		);
	});
});

// --- resolveProjectFromPath ---

describe("resolveProjectFromPath", () => {
	it("extracts project from standard vault path", () => {
		assert.equal(
			resolveProjectFromPath(
				"01_Projects/15_Claude_Orchestrator/15_Claude_Orchestrator.md",
				TEST_PROJECTS,
			),
			"15_Claude_Orchestrator",
		);
	});

	it("extracts project from nested note path", () => {
		assert.equal(
			resolveProjectFromPath(
				"01_Projects/15_Claude_Orchestrator/sessions/session-2.md",
				TEST_PROJECTS,
			),
			"15_Claude_Orchestrator",
		);
	});

	it("returns null for non-project paths", () => {
		assert.equal(resolveProjectFromPath("02_Areas/someNote.md", TEST_PROJECTS), null);
	});

	it("returns null for root-level files", () => {
		assert.equal(resolveProjectFromPath("README.md", TEST_PROJECTS), null);
	});

	it("returns null for unregistered project folders", () => {
		assert.equal(resolveProjectFromPath("01_Projects/99_Unknown/note.md", TEST_PROJECTS), null);
	});

	it("handles different project names", () => {
		assert.equal(
			resolveProjectFromPath(
				"01_Projects/14_Mobile_Claude_Code/notes.md",
				TEST_PROJECTS,
			),
			"14_Mobile_Claude_Code",
		);
	});

	it("works with arbitrary folder names", () => {
		const projects: ProjectRegistry = {
			"My Project": { vaultFolder: "work/my-project" },
		};
		assert.equal(
			resolveProjectFromPath("work/my-project/notes.md", projects),
			"My Project",
		);
	});

	it("picks the most specific (longest) match for nested folders", () => {
		const projects: ProjectRegistry = {
			"Parent": { vaultFolder: "projects" },
			"Child": { vaultFolder: "projects/sub" },
		};
		assert.equal(
			resolveProjectFromPath("projects/sub/note.md", projects),
			"Child",
		);
	});

	it("returns null for empty registry", () => {
		assert.equal(resolveProjectFromPath("any/path.md", {}), null);
	});

	it("matches vault root project (empty vaultFolder)", () => {
		const projects: ProjectRegistry = {
			"Root": { vaultFolder: "" },
		};
		assert.equal(resolveProjectFromPath("CLAUDE.md", projects), "Root");
		assert.equal(resolveProjectFromPath("01_Projects/foo/bar.md", projects), "Root");
	});

	it("prefers specific project over vault root", () => {
		const projects: ProjectRegistry = {
			"Root": { vaultFolder: "" },
			"Specific": { vaultFolder: "01_Projects/15_Claude" },
		};
		assert.equal(
			resolveProjectFromPath("01_Projects/15_Claude/note.md", projects),
			"Specific",
		);
		assert.equal(resolveProjectFromPath("other/note.md", projects), "Root");
	});
});

// --- normalizeViewState ---

describe("normalizeViewState", () => {
	it("extracts project and sessionName from full state", () => {
		const result = normalizeViewState({
			project: "15_Claude_Orchestrator",
			sessionName: "15_Claude_Orchestrator-2",
		});
		assert.equal(result.project, "15_Claude_Orchestrator");
		assert.equal(result.sessionName, "15_Claude_Orchestrator-2");
	});

	it("backward compat: defaults sessionName to project when missing", () => {
		const result = normalizeViewState({
			project: "15_Claude_Orchestrator",
		});
		assert.equal(result.project, "15_Claude_Orchestrator");
		assert.equal(result.sessionName, "15_Claude_Orchestrator");
	});

	it("handles empty state", () => {
		const result = normalizeViewState({});
		assert.equal(result.project, null);
		assert.equal(result.sessionName, null);
	});

	it("handles null input", () => {
		const result = normalizeViewState(null);
		assert.equal(result.project, null);
		assert.equal(result.sessionName, null);
	});

	it("handles undefined input", () => {
		const result = normalizeViewState(undefined);
		assert.equal(result.project, null);
		assert.equal(result.sessionName, null);
	});

	it("ignores non-string project", () => {
		const result = normalizeViewState({ project: 42 });
		assert.equal(result.project, null);
		assert.equal(result.sessionName, null);
	});

	it("ignores non-string sessionName but still defaults from project", () => {
		const result = normalizeViewState({
			project: "15_Claude_Orchestrator",
			sessionName: 42,
		});
		assert.equal(result.project, "15_Claude_Orchestrator");
		assert.equal(result.sessionName, "15_Claude_Orchestrator");
	});

	it("preserves explicit sessionName even if different from project", () => {
		const result = normalizeViewState({
			project: "15_Claude_Orchestrator",
			sessionName: "custom-name",
		});
		assert.equal(result.project, "15_Claude_Orchestrator");
		assert.equal(result.sessionName, "custom-name");
	});
});

// --- parseTmuxSessionsForProject ---

describe("parseTmuxSessionsForProject", () => {
	const SAMPLE_TMUX_LS = [
		"14_Mobile_Claude_Code: 1 windows (created Tue Apr 15 10:00:00 2026)",
		"15_Claude_Orchestrator: 2 windows (created Tue Apr 15 10:01:00 2026)",
		"15_Claude_Orchestrator-2: 1 windows (created Tue Apr 15 10:02:00 2026)",
		"15_Claude_Orchestrator-3: 1 windows (created Tue Apr 15 10:03:00 2026)",
		"99_Unrelated: 1 windows (created Tue Apr 15 10:04:00 2026)",
	].join("\n");

	it("finds base and numbered sessions for a project", () => {
		const { names } = parseTmuxSessionsForProject(
			SAMPLE_TMUX_LS,
			"15_Claude_Orchestrator",
		);
		assert.deepEqual(names, [
			"15_Claude_Orchestrator",
			"15_Claude_Orchestrator-2",
			"15_Claude_Orchestrator-3",
		]);
	});

	it("finds only the base session when no numbered ones exist", () => {
		const { names } = parseTmuxSessionsForProject(
			SAMPLE_TMUX_LS,
			"14_Mobile_Claude_Code",
		);
		assert.deepEqual(names, ["14_Mobile_Claude_Code"]);
	});

	it("returns empty array when no sessions match", () => {
		const { names } = parseTmuxSessionsForProject(
			SAMPLE_TMUX_LS,
			"nonexistent_project",
		);
		assert.deepEqual(names, []);
	});

	it("returns empty array for empty tmux output", () => {
		const { names } = parseTmuxSessionsForProject(
			"",
			"15_Claude_Orchestrator",
		);
		assert.deepEqual(names, []);
	});

	it("does not match partial project name prefix", () => {
		const output =
			"15_Claude: 1 windows (created Tue Apr 15 10:00:00 2026)\n" +
			"15_Claude_Orchestrator: 1 windows (created Tue Apr 15 10:01:00 2026)";
		const { names } = parseTmuxSessionsForProject(output, "15_Claude");
		assert.deepEqual(names, ["15_Claude"]);
	});

	it("does not match non-numeric suffixes", () => {
		const output =
			"15_Claude_Orchestrator: 1 windows (created Tue Apr 15 10:00:00 2026)\n" +
			"15_Claude_Orchestrator-beta: 1 windows (created Tue Apr 15 10:01:00 2026)";
		const { names } = parseTmuxSessionsForProject(
			output,
			"15_Claude_Orchestrator",
		);
		assert.deepEqual(names, ["15_Claude_Orchestrator"]);
	});

	it("sorts names alphabetically but tracks mostRecent by activity", () => {
		const output = [
			"15_Claude_Orchestrator-2:1776317713",
			"15_Claude_Orchestrator:1776317847",
			"15_Claude_Orchestrator-3:1776317500",
		].join("\n");
		const { names, mostRecent } = parseTmuxSessionsForProject(
			output,
			"15_Claude_Orchestrator",
		);
		// Alphabetical order
		assert.deepEqual(names, [
			"15_Claude_Orchestrator",
			"15_Claude_Orchestrator-2",
			"15_Claude_Orchestrator-3",
		]);
		// Most recent by activity
		assert.equal(mostRecent, "15_Claude_Orchestrator");
	});

	it("returns mostRecent as null when no sessions match", () => {
		const { mostRecent } = parseTmuxSessionsForProject("", "nope");
		assert.equal(mostRecent, null);
	});
});

// --- sessionNotePath ---

// --- sessionDirPath ---

describe("sessionDirPath", () => {
	it("returns folder/sessions for normal project", () => {
		assert.equal(sessionDirPath("01_Projects/15_Claude_Orchestrator"), "01_Projects/15_Claude_Orchestrator/sessions");
	});

	it("returns 'sessions' for empty vaultFolder", () => {
		assert.equal(sessionDirPath(""), "sessions");
	});

	it("returns 'sessions' for '/' vaultFolder (root project)", () => {
		assert.equal(sessionDirPath("/"), "sessions");
	});

	it("returns 'sessions' for '.' vaultFolder", () => {
		assert.equal(sessionDirPath("."), "sessions");
	});

	it("strips trailing slash from normal folder", () => {
		assert.equal(sessionDirPath("projects/foo/"), "projects/foo/sessions");
	});
});

// --- sessionNotePath ---

describe("sessionNotePath", () => {
	it("returns correct vault-relative path", () => {
		assert.equal(
			sessionNotePath("01_Projects/15_Claude_Orchestrator", "15_Claude_Orchestrator"),
			"01_Projects/15_Claude_Orchestrator/sessions/15_Claude_Orchestrator.md",
		);
	});

	it("handles numbered session names", () => {
		assert.equal(
			sessionNotePath("01_Projects/15_Claude_Orchestrator", "15_Claude_Orchestrator-2"),
			"01_Projects/15_Claude_Orchestrator/sessions/15_Claude_Orchestrator-2.md",
		);
	});

	it("works with arbitrary vault folders", () => {
		assert.equal(
			sessionNotePath("work/my-project", "my-project"),
			"work/my-project/sessions/my-project.md",
		);
	});

	it("handles vault root (empty vaultFolder)", () => {
		assert.equal(
			sessionNotePath("", "my-session"),
			"sessions/my-session.md",
		);
	});

	it("handles '/' vaultFolder (root project)", () => {
		assert.equal(
			sessionNotePath("/", "ClaudeRoot"),
			"sessions/ClaudeRoot.md",
		);
	});

	it("handles '/' vaultFolder with numbered session", () => {
		assert.equal(
			sessionNotePath("/", "ClaudeRoot-2"),
			"sessions/ClaudeRoot-2.md",
		);
	});
});

// --- archiveSessionNotePath ---

describe("archiveSessionNotePath", () => {
	it("returns archive path with prefix", () => {
		assert.equal(
			archiveSessionNotePath("01_Projects/MyProject", "MyProject-1"),
			"01_Projects/MyProject/sessions/archive-MyProject-1.md",
		);
	});

	it("handles vault root", () => {
		assert.equal(
			archiveSessionNotePath("", "my-session"),
			"sessions/archive-my-session.md",
		);
	});
});

// --- renamedSessionNotePath ---

describe("renamedSessionNotePath", () => {
	it("returns old and new paths for rename", () => {
		const result = renamedSessionNotePath("01_Projects/MyProject", "MyProject-1", "MyProject-2");
		assert.equal(result.oldPath, "01_Projects/MyProject/sessions/MyProject-1.md");
		assert.equal(result.newPath, "01_Projects/MyProject/sessions/MyProject-2.md");
	});

	it("handles vault root", () => {
		const result = renamedSessionNotePath("", "old-session", "new-session");
		assert.equal(result.oldPath, "sessions/old-session.md");
		assert.equal(result.newPath, "sessions/new-session.md");
	});
});

// --- createDefaultSessionNote ---

describe("createDefaultSessionNote", () => {
	it("creates valid frontmatter and empty sections", () => {
		const content = createDefaultSessionNote("15_Claude_Orchestrator");
		assert.ok(content.includes("session: 15_Claude_Orchestrator"));
		assert.ok(content.includes("status: idle"));
		assert.ok(content.includes("## History"));
		assert.ok(content.includes("## Queue"));
	});

	it("round-trips through parse", () => {
		const content = createDefaultSessionNote("test-session");
		const parsed = parseSessionNote(content);
		assert.equal(parsed.session, "test-session");
		assert.equal(parsed.status, "idle");
		assert.deepEqual(parsed.history, []);
		assert.deepEqual(parsed.queue, []);
	});
});

// --- parseSessionNote ---

describe("parseSessionNote", () => {
	const FULL_NOTE = [
		"---",
		"session: 15_Claude_Orchestrator",
		"status: running",
		"---",
		"",
		"## History",
		"- [x] 初始化项目脚手架",
		"- [x] 添加焦点遮罩功能",
		"- [ ] 重构 auth 模块",
		"",
		"## Queue",
		"- 写 auth 模块的单元测试",
		"- 更新 README",
		"",
	].join("\n");

	it("parses frontmatter correctly", () => {
		const note = parseSessionNote(FULL_NOTE);
		assert.equal(note.session, "15_Claude_Orchestrator");
		assert.equal(note.status, "running");
	});

	it("parses history items with checkboxes", () => {
		const note = parseSessionNote(FULL_NOTE);
		assert.equal(note.history.length, 3);
		assert.deepEqual(note.history[0], { text: "初始化项目脚手架", completed: true });
		assert.deepEqual(note.history[1], { text: "添加焦点遮罩功能", completed: true });
		assert.deepEqual(note.history[2], { text: "重构 auth 模块", completed: false });
	});

	it("parses queue items", () => {
		const note = parseSessionNote(FULL_NOTE);
		assert.deepEqual(note.queue, [
			"写 auth 模块的单元测试",
			"更新 README",
		]);
	});

	it("handles empty note with fallback session", () => {
		const note = parseSessionNote("", "fallback");
		assert.equal(note.session, "fallback");
		assert.equal(note.status, "idle");
		assert.deepEqual(note.history, []);
		assert.deepEqual(note.queue, []);
	});

	it("handles note with no frontmatter", () => {
		const content = "## History\n- [x] done\n\n## Queue\n- todo\n";
		const note = parseSessionNote(content, "fb");
		assert.equal(note.session, "fb");
		assert.equal(note.history.length, 1);
		assert.equal(note.queue.length, 1);
	});

	it("handles plain list items in history (no checkbox)", () => {
		const content = "## History\n- some task without checkbox\n";
		const note = parseSessionNote(content);
		assert.deepEqual(note.history[0], {
			text: "some task without checkbox",
			completed: false,
		});
	});

	it("ignores unknown frontmatter status values", () => {
		const content = "---\nstatus: banana\n---\n";
		const note = parseSessionNote(content);
		assert.equal(note.status, "idle");
	});
});

// --- serializeSessionNote ---

describe("serializeSessionNote", () => {
	it("produces valid markdown", () => {
		const note = {
			session: "test",
			status: "running" as const,
			history: [
				{ text: "done task", completed: true },
				{ text: "in progress", completed: false },
			],
			queue: ["next task", "after that"],
		};
		const md = serializeSessionNote(note);
		assert.ok(md.includes("session: test"));
		assert.ok(md.includes("status: running"));
		assert.ok(md.includes("- [x] done task"));
		assert.ok(md.includes("- [ ] in progress"));
		assert.ok(md.includes("- next task"));
		assert.ok(md.includes("- after that"));
	});

	it("round-trips with parseSessionNote", () => {
		const original = {
			session: "15_Claude_Orchestrator-2",
			status: "waiting_for_user" as const,
			queueMode: "manual" as const,
			displayName: "",
			summary: "",
			notes: "",
			history: [
				{ text: "task A", completed: true },
				{ text: "task B", completed: false },
			],
			queue: ["task C", "task D"],
		};
		const md = serializeSessionNote(original);
		const parsed = parseSessionNote(md);
		assert.deepEqual(parsed, original);
	});

	it("handles empty history and queue", () => {
		const note = {
			session: "empty",
			status: "idle" as const,
			queueMode: "manual" as const,
			displayName: "",
			summary: "",
			notes: "",
			history: [],
			queue: [],
		};
		const md = serializeSessionNote(note);
		const parsed = parseSessionNote(md);
		assert.deepEqual(parsed, note);
	});

	it("status-only update preserves history completion state", () => {
		const note: SessionNote = {
			session: "test-1",
			status: "running",
			queueMode: "manual",
			displayName: "",
			summary: "",
			notes: "",
			history: [
				{ text: "[2026-04-19 12:00] fix auth", completed: true },
				{ text: "[2026-04-19 12:05] add tests", completed: false },
			],
			queue: ["next task"],
		};
		// Simulate: only update status (like updateSessionStatus does)
		note.status = "idle";
		const md = serializeSessionNote(note);
		const reparsed = parseSessionNote(md);
		assert.equal(reparsed.status, "idle");
		assert.equal(reparsed.history[0]?.completed, true, "completed item must stay completed");
		assert.equal(reparsed.history[1]?.completed, false, "uncompleted item must stay uncompleted");
	});
});

// --- parseAllTmuxSessions ---

describe("parseAllTmuxSessions", () => {
	it("parses format-string output into name+activity pairs", () => {
		const output = [
			"15_Claude_Orchestrator:1776317847",
			"15_Claude_Orchestrator-2:1776317713",
			"14_Mobile_Claude_Code:1776317500",
		].join("\n");
		const sessions = parseAllTmuxSessions(output);
		assert.equal(sessions.length, 3);
		assert.equal(sessions[0].name, "15_Claude_Orchestrator");
		assert.equal(sessions[0].activity, 1776317847);
		assert.equal(sessions[2].name, "14_Mobile_Claude_Code");
	});

	it("returns empty array for empty input", () => {
		assert.deepEqual(parseAllTmuxSessions(""), []);
	});

	it("handles lines without activity timestamp", () => {
		const output = "my-session: 1 windows (created Tue Apr 15 10:00:00 2026)";
		const sessions = parseAllTmuxSessions(output);
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].name, "my-session");
		assert.equal(sessions[0].activity, 0);
	});

	it("skips blank lines", () => {
		const output = "sess-a:100\n\nsess-b:200\n";
		const sessions = parseAllTmuxSessions(output);
		assert.equal(sessions.length, 2);
	});
});

// --- projectFromSessionName ---

describe("projectFromSessionName", () => {
	it("returns project for exact match", () => {
		assert.equal(projectFromSessionName("15_Claude_Orchestrator", TEST_PROJECTS), "15_Claude_Orchestrator");
	});

	it("strips -N suffix", () => {
		assert.equal(projectFromSessionName("15_Claude_Orchestrator-2", TEST_PROJECTS), "15_Claude_Orchestrator");
	});

	it("strips -N for higher numbers", () => {
		assert.equal(projectFromSessionName("15_Claude_Orchestrator-15", TEST_PROJECTS), "15_Claude_Orchestrator");
	});

	it("returns null for unregistered session name", () => {
		assert.equal(projectFromSessionName("my-random-session", TEST_PROJECTS), null);
	});

	it("returns null for bare word not in registry", () => {
		assert.equal(projectFromSessionName("scratch", TEST_PROJECTS), null);
	});

	it("matches arbitrary project names in registry", () => {
		const projects: ProjectRegistry = {
			"my-project": { vaultFolder: "work/my-project" },
		};
		assert.equal(projectFromSessionName("my-project", projects), "my-project");
		assert.equal(projectFromSessionName("my-project-2", projects), "my-project");
	});

	it("returns null for empty registry", () => {
		assert.equal(projectFromSessionName("anything", {}), null);
	});
});

// --- sessionsMissingNotes ---

describe("sessionsMissingNotes", () => {
	it("returns sessions without existing note files", () => {
		const projects: ProjectRegistry = {
			MyProject: { vaultFolder: "01_Projects/MyProject" },
		};
		const existing = new Set(["01_Projects/MyProject/sessions/MyProject-1.md"]);
		const result = sessionsMissingNotes(
			["MyProject-1", "MyProject-2"],
			projects,
			existing,
		);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.sessionName, "MyProject-2");
		assert.equal(result[0]!.notePath, "01_Projects/MyProject/sessions/MyProject-2.md");
	});

	it("skips unmanaged sessions", () => {
		const projects: ProjectRegistry = {
			MyProject: { vaultFolder: "01_Projects/MyProject" },
		};
		const result = sessionsMissingNotes(
			["random-session"],
			projects,
			new Set(),
		);
		assert.equal(result.length, 0);
	});

	it("returns empty when all notes exist", () => {
		const projects: ProjectRegistry = {
			MyProject: { vaultFolder: "01_Projects/MyProject" },
		};
		const existing = new Set([
			"01_Projects/MyProject/sessions/MyProject-1.md",
			"01_Projects/MyProject/sessions/MyProject-2.md",
		]);
		const result = sessionsMissingNotes(
			["MyProject-1", "MyProject-2"],
			projects,
			existing,
		);
		assert.equal(result.length, 0);
	});

	it("includes dirPath for folder creation", () => {
		const projects: ProjectRegistry = {
			MyProject: { vaultFolder: "01_Projects/MyProject" },
		};
		const result = sessionsMissingNotes(["MyProject-1"], projects, new Set());
		assert.equal(result[0]!.dirPath, "01_Projects/MyProject/sessions");
	});
});

// --- groupSessionsByProject ---

describe("groupSessionsByProject", () => {
	const sessions = [
		{ name: "15_Claude_Orchestrator", activity: 100 },
		{ name: "15_Claude_Orchestrator-2", activity: 200 },
		{ name: "14_Mobile_Claude_Code", activity: 300 },
		{ name: "random-session", activity: 50 },
	];

	it("groups sessions by project with Unmanaged bucket", () => {
		const groups = groupSessionsByProject(
			sessions,
			new Set(["15_Claude_Orchestrator", "14_Mobile_Claude_Code"]),
			new Map([
				["15_Claude_Orchestrator", { queueCount: 2, lastActivity: "2026-04-15 14:30", preview: "do the thing" }],
				["14_Mobile_Claude_Code", { queueCount: 0, lastActivity: null, preview: null }],
			]),
			TEST_PROJECTS,
		);

		assert.equal(groups.length, 3); // 14_, 15_, Unmanaged
		assert.equal(groups[0].project, "14_Mobile_Claude_Code");
		assert.equal(groups[0].sessions.length, 1);
		assert.equal(groups[1].project, "15_Claude_Orchestrator");
		assert.equal(groups[1].sessions.length, 2);
		assert.equal(groups[2].project, "Unmanaged");
		assert.equal(groups[2].sessions.length, 1);
	});

	it("sets hasPanel correctly", () => {
		const groups = groupSessionsByProject(
			sessions,
			new Set(["15_Claude_Orchestrator"]),
			new Map(),
			TEST_PROJECTS,
		);
		const orch = groups.find((g) => g.project === "15_Claude_Orchestrator")!;
		assert.equal(orch.sessions[0].hasPanel, true);  // 15_Claude_Orchestrator
		assert.equal(orch.sessions[1].hasPanel, false); // 15_Claude_Orchestrator-2
	});

	it("sets hasNote and noteData correctly", () => {
		const groups = groupSessionsByProject(
			sessions,
			new Set(),
			new Map([
				["15_Claude_Orchestrator", { queueCount: 3, lastActivity: "2026-04-15 10:00", preview: "task preview" }],
			]),
			TEST_PROJECTS,
		);
		const orch = groups.find((g) => g.project === "15_Claude_Orchestrator")!;
		assert.equal(orch.sessions[0].hasNote, true);
		assert.equal(orch.sessions[0].queueCount, 3);
		assert.equal(orch.sessions[1].hasNote, false);
		assert.equal(orch.sessions[1].queueCount, 0);
	});

	it("returns empty array for no sessions and no projects", () => {
		const groups = groupSessionsByProject([], new Set(), new Map(), {});
		assert.deepEqual(groups, []);
	});

	it("shows registered projects with 0 sessions", () => {
		const groups = groupSessionsByProject([], new Set(), new Map(), TEST_PROJECTS);
		assert.equal(groups.length, 2);
		assert.equal(groups[0].project, "14_Mobile_Claude_Code");
		assert.equal(groups[0].sessions.length, 0);
		assert.equal(groups[1].project, "15_Claude_Orchestrator");
		assert.equal(groups[1].sessions.length, 0);
	});

	it("hasEverHadSession false for new project with no sessions and no notes", () => {
		const groups = groupSessionsByProject([], new Set(), new Map(), TEST_PROJECTS);
		const orch = groups.find((g) => g.project === "15_Claude_Orchestrator")!;
		assert.equal(orch.hasEverHadSession, false);
	});

	it("hasEverHadSession true when project has active sessions", () => {
		const groups = groupSessionsByProject(
			[{ name: "15_Claude_Orchestrator-1", activity: 100 }],
			new Set(),
			new Map(),
			TEST_PROJECTS,
		);
		const orch = groups.find((g) => g.project === "15_Claude_Orchestrator")!;
		assert.equal(orch.hasEverHadSession, true);
	});

	it("hasEverHadSession true when project has notes on disk but no active sessions", () => {
		const groups = groupSessionsByProject(
			[],
			new Set(),
			new Map(),
			TEST_PROJECTS,
			new Set(["15_Claude_Orchestrator"]),
		);
		const orch = groups.find((g) => g.project === "15_Claude_Orchestrator")!;
		assert.equal(orch.hasEverHadSession, true);
		assert.equal(orch.sessions.length, 0);
	});

	it("sorts projects alphabetically and sessions within each project", () => {
		const sortProjects: ProjectRegistry = {
			"10_A_Project": { vaultFolder: "01_Projects/10_A_Project" },
			"20_Z_Project": { vaultFolder: "01_Projects/20_Z_Project" },
		};
		const groups = groupSessionsByProject(
			[
				{ name: "20_Z_Project-3", activity: 0 },
				{ name: "10_A_Project", activity: 0 },
				{ name: "20_Z_Project", activity: 0 },
			],
			new Set(),
			new Map(),
			sortProjects,
		);
		assert.equal(groups[0].project, "10_A_Project");
		assert.equal(groups[1].project, "20_Z_Project");
		assert.equal(groups[1].sessions[0].name, "20_Z_Project");
		assert.equal(groups[1].sessions[1].name, "20_Z_Project-3");
	});
});

// --- nowStamp ---

describe("nowStamp", () => {
	it("returns YYYY-MM-DD HH:MM format", () => {
		const stamp = nowStamp();
		assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	});

	it("pads single-digit months and days", () => {
		const stamp = nowStamp();
		// Can't control the clock, but format should always be padded
		const parts = stamp.split(/[-: ]/);
		assert.equal(parts.length, 5);
		assert.equal(parts[1]!.length, 2); // month
		assert.equal(parts[2]!.length, 2); // day
		assert.equal(parts[3]!.length, 2); // hour
		assert.equal(parts[4]!.length, 2); // minute
	});
});

// --- formatRelativeTime ---

describe("formatRelativeTime", () => {
	// Use a fixed "now" for deterministic tests
	const now = new Date(2026, 3, 16, 14, 30); // 2026-04-16 14:30

	it("returns 'just now' for < 1 minute ago", () => {
		assert.equal(formatRelativeTime("2026-04-16 14:30", now), "just now");
	});

	it("returns minutes for < 60 minutes", () => {
		assert.equal(formatRelativeTime("2026-04-16 14:05", now), "25m ago");
	});

	it("returns hours for < 24 hours", () => {
		assert.equal(formatRelativeTime("2026-04-16 11:30", now), "3h ago");
	});

	it("returns days for >= 24 hours", () => {
		assert.equal(formatRelativeTime("2026-04-14 14:30", now), "2d ago");
	});

	it("returns raw stamp for future timestamps", () => {
		assert.equal(formatRelativeTime("2026-04-17 10:00", now), "2026-04-17 10:00");
	});

	it("returns raw stamp for malformed input", () => {
		assert.equal(formatRelativeTime("not-a-date", now), "not-a-date");
	});

	it("handles midnight boundary", () => {
		const midnight = new Date(2026, 3, 16, 0, 0);
		assert.equal(formatRelativeTime("2026-04-15 23:00", midnight), "1h ago");
	});
});

// --- parseSessionNote: multiline items ---

describe("parseSessionNote multiline", () => {
	it("parses multiline queue items with indented continuation", () => {
		const md = [
			"---",
			"session: test",
			"status: idle",
			"pinnedNote: ",
			"---",
			"",
			"## Queue",
			"- [2026-04-16 10:00] First line",
			"  continuation of first item",
			"  another line",
			"- Second item",
			"",
		].join("\n");
		const note = parseSessionNote(md);
		assert.equal(note.queue.length, 2);
		assert.equal(note.queue[0], "[2026-04-16 10:00] First line\ncontinuation of first item\nanother line");
		assert.equal(note.queue[1], "Second item");
	});

	it("round-trips multiline items", () => {
		const original = {
			session: "test",
			status: "idle" as const,
			history: [
				{ text: "line1\nline2\nline3", completed: true },
			],
			queue: ["task A\n  with details", "task B"],
		};
		const md = serializeSessionNote(original);
		const parsed = parseSessionNote(md);
		assert.equal(parsed.history[0]!.text, "line1\nline2\nline3");
		assert.equal(parsed.queue[0], "task A\nwith details");
		assert.equal(parsed.queue[1], "task B");
	});

	it("parses multiline items with blank lines and headings", () => {
		const md = [
			"---",
			"session: test",
			"status: idle",
			"pinnedNote: ",
			"---",
			"",
			"## Queue",
			"- [2026-04-16 23:12] 按照 Tasks_Convention 执行以下任务。",
			"  ",
			"  ## 任务",
			"  修复 display text bug。",
			"  ",
			"  ## 参数",
			"  - 分支：fix/display-text",
			"",
		].join("\n");
		const note = parseSessionNote(md);
		assert.equal(note.queue.length, 1);
		assert.ok(note.queue[0]!.includes("按照 Tasks_Convention"));
		assert.ok(note.queue[0]!.includes("## 任务"));
		assert.ok(note.queue[0]!.includes("修复 display text bug"));
		assert.ok(note.queue[0]!.includes("## 参数"));
		assert.ok(note.queue[0]!.includes("分支：fix/display-text"));
	});

	it("round-trips multiline items with blank lines", () => {
		const original = {
			session: "test",
			status: "idle" as const,
			history: [],
			queue: ["[2026-04-16 23:12] Line one\n\n## Section\nContent"],
		};
		const md = serializeSessionNote(original);
		const parsed = parseSessionNote(md);
		assert.equal(parsed.queue.length, 1);
		assert.ok(parsed.queue[0]!.includes("## Section"));
		assert.ok(parsed.queue[0]!.includes("Content"));
	});

});

// --- migrateSettings ---

describe("migrateSettings", () => {
	it("migrates queuePanel: true to simpleMode: false", () => {
		const result = migrateSettings({ queuePanel: true });
		assert.equal(result.simpleMode, false);
		assert.equal("queuePanel" in result, false);
	});

	it("migrates queuePanel: false to simpleMode: true", () => {
		const result = migrateSettings({ queuePanel: false });
		assert.equal(result.simpleMode, true);
		assert.equal("queuePanel" in result, false);
	});

	it("does not touch simpleMode if already present", () => {
		const result = migrateSettings({ simpleMode: true });
		assert.equal(result.simpleMode, true);
	});

	it("prefers existing simpleMode over queuePanel", () => {
		const result = migrateSettings({ queuePanel: true, simpleMode: true });
		assert.equal(result.simpleMode, true);
		assert.equal("queuePanel" in result, true);
	});

	it("returns empty object unchanged", () => {
		const result = migrateSettings({});
		assert.deepEqual(result, {});
	});

	it("preserves other fields during migration", () => {
		const result = migrateSettings({ queuePanel: true, otherSetting: "hello" });
		assert.equal(result.simpleMode, false);
		assert.equal(result.otherSetting, "hello");
		assert.equal("queuePanel" in result, false);
	});

	it("does not mutate the input object", () => {
		const input = { queuePanel: true };
		migrateSettings(input);
		assert.equal("queuePanel" in input, true);
		assert.equal("simpleMode" in input, false);
	});
});

// --- findTmuxBinary ---

describe("findTmuxBinary", () => {
	it("returns first existing path from search list", () => {
		const result = findTmuxBinary((p) => p === TMUX_SEARCH_PATHS[0]);
		assert.equal(result, TMUX_SEARCH_PATHS[0]);
	});

	it("returns second path when first does not exist", () => {
		const result = findTmuxBinary((p) => p === TMUX_SEARCH_PATHS[1]);
		assert.equal(result, TMUX_SEARCH_PATHS[1]);
	});

	it("falls back to bare 'tmux' when no paths exist", () => {
		const result = findTmuxBinary(() => false);
		assert.equal(result, "tmux");
	});

	it("stops at the first match", () => {
		const checked: string[] = [];
		findTmuxBinary((p) => { checked.push(p); return true; });
		assert.equal(checked.length, 1);
		assert.equal(checked[0], TMUX_SEARCH_PATHS[0]);
	});

	it("checks all paths before falling back", () => {
		const checked: string[] = [];
		findTmuxBinary((p) => { checked.push(p); return false; });
		assert.equal(checked.length, TMUX_SEARCH_PATHS.length);
	});

	it("returns an absolute path or bare 'tmux' with real fs", () => {
		const result = findTmuxBinary();
		assert.ok(result === "tmux" || result.startsWith("/"));
	});
});

// --- HISTORY_ITEM_MIN_HEIGHT ---

describe("HISTORY_ITEM_MIN_HEIGHT", () => {
	it("is a positive number", () => {
		assert.ok(typeof HISTORY_ITEM_MIN_HEIGHT === "number");
		assert.ok(HISTORY_ITEM_MIN_HEIGHT > 0);
	});

	it("accounts for one history item plus content padding", () => {
		// The constant should be large enough to show one history item:
		// item height (~21px from font-size 12 * line-height 1.4 + padding 4)
		// plus content padding (4px top + 4px bottom = 8px).
		// So the minimum should be >= 25px.
		assert.ok(HISTORY_ITEM_MIN_HEIGHT >= 25, `Expected >= 25, got ${HISTORY_ITEM_MIN_HEIGHT}`);
	});

	it("is smaller than the default max height (120px)", () => {
		assert.ok(HISTORY_ITEM_MIN_HEIGHT < 120, `Expected < 120, got ${HISTORY_ITEM_MIN_HEIGHT}`);
	});
});

// --- copyHistoryItemToQueue ---

describe("copyHistoryItemToQueue", () => {
	it("appends history item text to queue with a timestamp", () => {
		const queue: string[] = [];
		copyHistoryItemToQueue("do the thing", queue);
		assert.equal(queue.length, 1);
		assert.match(queue[0]!, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] do the thing$/);
	});

	it("appends to the end of an existing queue", () => {
		const queue = ["[2026-04-16 10:00] first task"];
		copyHistoryItemToQueue("second task", queue);
		assert.equal(queue.length, 2);
		assert.match(queue[1]!, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] second task$/);
	});

	it("strips existing timestamp prefix from history text before re-stamping", () => {
		const queue: string[] = [];
		copyHistoryItemToQueue("[2026-04-15 09:00] old task", queue);
		assert.equal(queue.length, 1);
		// Should have a new timestamp, not the old one doubled
		assert.match(queue[0]!, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] old task$/);
		// The old timestamp should not appear in the body
		assert.ok(!queue[0]!.includes("[2026-04-15 09:00] [2026-04-15 09:00]"));
	});

	it("handles multiline history items", () => {
		const queue: string[] = [];
		copyHistoryItemToQueue("line one\nline two\nline three", queue);
		assert.equal(queue.length, 1);
		assert.match(queue[0]!, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] line one\nline two\nline three$/);
	});

	it("returns the index where the item was inserted", () => {
		const queue = ["existing"];
		const idx = copyHistoryItemToQueue("new item", queue);
		assert.equal(idx, 1);
	});
});

// --- shouldAutoSendAfterEdit ---

describe("shouldAutoSendAfterEdit", () => {
	it("returns true when queue has exactly 1 item", () => {
		assert.equal(shouldAutoSendAfterEdit(1), true);
	});

	it("returns false when queue is empty", () => {
		assert.equal(shouldAutoSendAfterEdit(0), false);
	});

	it("returns false when queue has 2 items", () => {
		assert.equal(shouldAutoSendAfterEdit(2), false);
	});

	it("returns false when queue has many items", () => {
		assert.equal(shouldAutoSendAfterEdit(10), false);
	});
});

// --- validateProjectKey ---

describe("validateProjectKey", () => {
	it("rejects empty string", () => {
		assert.notEqual(validateProjectKey("", new Set()), null);
	});

	it("rejects whitespace-only string", () => {
		assert.notEqual(validateProjectKey("   ", new Set()), null);
	});

	it("rejects name containing period", () => {
		assert.notEqual(validateProjectKey("my.project", new Set()), null);
	});

	it("rejects name containing colon", () => {
		assert.notEqual(validateProjectKey("my:project", new Set()), null);
	});

	it("rejects reserved name 'Unmanaged'", () => {
		assert.notEqual(validateProjectKey("Unmanaged", new Set()), null);
	});

	it("rejects duplicate key", () => {
		assert.notEqual(validateProjectKey("my-project", new Set(["my-project"])), null);
	});

	it("accepts valid simple name", () => {
		assert.equal(validateProjectKey("my-project", new Set()), null);
	});

	it("accepts name with spaces", () => {
		assert.equal(validateProjectKey("My Project", new Set()), null);
	});

	it("accepts name with underscores and digits", () => {
		assert.equal(validateProjectKey("15_Claude_Orchestrator", new Set()), null);
	});

	it("accepts unicode names", () => {
		assert.equal(validateProjectKey("我的项目", new Set()), null);
	});

	it("allows own key as non-duplicate when editing", () => {
		assert.equal(validateProjectKey("my-project", new Set(["my-project"]), "my-project"), null);
	});

	it("still rejects other duplicates when editing", () => {
		assert.notEqual(validateProjectKey("other", new Set(["other"]), "my-project"), null);
	});
});

// --- addProject ---

describe("addProject", () => {
	it("adds to empty registry", () => {
		const result = addProject({}, "my-project", { vaultFolder: "projects/my-project" });
		assert.deepEqual(result, {
			"my-project": { vaultFolder: "projects/my-project" },
		});
	});

	it("adds to non-empty registry without affecting existing", () => {
		const existing: ProjectRegistry = {
			"proj-a": { vaultFolder: "a" },
		};
		const result = addProject(existing, "proj-b", { vaultFolder: "b" });
		assert.equal(Object.keys(result).length, 2);
		assert.deepEqual(result["proj-a"], { vaultFolder: "a" });
		assert.deepEqual(result["proj-b"], { vaultFolder: "b" });
	});

	it("preserves all optional fields", () => {
		const config = {
			vaultFolder: "work/proj",
			workingDirectory: "/Users/me/code/proj",
			mainNote: "work/proj/README.md",
		};
		const result = addProject({}, "proj", config);
		assert.deepEqual(result["proj"], config);
	});

	it("does not mutate the original registry", () => {
		const original: ProjectRegistry = { "a": { vaultFolder: "a" } };
		addProject(original, "b", { vaultFolder: "b" });
		assert.equal(Object.keys(original).length, 1);
	});
});

// --- updateProjectConfig ---

describe("updateProjectConfig", () => {
	it("updates vaultFolder", () => {
		const registry: ProjectRegistry = {
			"proj": { vaultFolder: "old/path" },
		};
		const result = updateProjectConfig(registry, "proj", { vaultFolder: "new/path" });
		assert.equal(result["proj"]?.vaultFolder, "new/path");
	});

	it("adds optional field without affecting others", () => {
		const registry: ProjectRegistry = {
			"proj": { vaultFolder: "path", mainNote: "note.md" },
		};
		const result = updateProjectConfig(registry, "proj", { workingDirectory: "/code" });
		assert.equal(result["proj"]?.vaultFolder, "path");
		assert.equal(result["proj"]?.mainNote, "note.md");
		assert.equal(result["proj"]?.workingDirectory, "/code");
	});

	it("clears optional field when set to undefined", () => {
		const registry: ProjectRegistry = {
			"proj": { vaultFolder: "path", workingDirectory: "/code" },
		};
		const result = updateProjectConfig(registry, "proj", { workingDirectory: undefined });
		assert.equal(result["proj"]?.workingDirectory, undefined);
	});

	it("returns registry unchanged for non-existent key", () => {
		const registry: ProjectRegistry = { "a": { vaultFolder: "a" } };
		const result = updateProjectConfig(registry, "nonexistent", { vaultFolder: "x" });
		assert.deepEqual(result, registry);
	});

	it("does not mutate the original registry or config", () => {
		const registry: ProjectRegistry = { "proj": { vaultFolder: "old" } };
		const result = updateProjectConfig(registry, "proj", { vaultFolder: "new" });
		assert.equal(registry["proj"]?.vaultFolder, "old");
		assert.equal(result["proj"]?.vaultFolder, "new");
	});
});

// --- removeProject ---

describe("removeProject", () => {
	it("removes existing project", () => {
		const registry: ProjectRegistry = {
			"a": { vaultFolder: "a" },
			"b": { vaultFolder: "b" },
		};
		const result = removeProject(registry, "a");
		assert.equal(Object.keys(result).length, 1);
		assert.equal(result["a"], undefined);
		assert.deepEqual(result["b"], { vaultFolder: "b" });
	});

	it("returns empty registry when removing last project", () => {
		const registry: ProjectRegistry = { "only": { vaultFolder: "x" } };
		const result = removeProject(registry, "only");
		assert.deepEqual(result, {});
	});

	it("returns registry unchanged for non-existent key", () => {
		const registry: ProjectRegistry = { "a": { vaultFolder: "a" } };
		const result = removeProject(registry, "nonexistent");
		assert.deepEqual(result, registry);
	});

	it("does not mutate the original registry", () => {
		const registry: ProjectRegistry = {
			"a": { vaultFolder: "a" },
			"b": { vaultFolder: "b" },
		};
		removeProject(registry, "a");
		assert.equal(Object.keys(registry).length, 2);
	});
});

// --- normalizeVaultFolder ---

describe("normalizeVaultFolder", () => {
	it("strips leading slash", () => {
		assert.equal(normalizeVaultFolder("/"), "");
	});

	it("strips trailing slash", () => {
		assert.equal(normalizeVaultFolder("01_Projects/foo/"), "01_Projects/foo");
	});

	it("strips both leading and trailing slashes", () => {
		assert.equal(normalizeVaultFolder("/projects/foo/"), "projects/foo");
	});

	it("normalizes dot to empty string", () => {
		assert.equal(normalizeVaultFolder("."), "");
	});

	it("leaves normal paths unchanged", () => {
		assert.equal(normalizeVaultFolder("01_Projects/15_Claude"), "01_Projects/15_Claude");
	});

	it("returns empty string for empty input", () => {
		assert.equal(normalizeVaultFolder(""), "");
	});
});

// --- computeDisplayText ---

describe("computeDisplayText", () => {
	it("returns fallback when both null", () => {
		assert.equal(computeDisplayText(null, null), "Claude Orchestrator");
	});

	it("returns fallback when project is null", () => {
		assert.equal(computeDisplayText(null, "some-session"), "Claude Orchestrator");
	});

	it("returns fallback when sessionName is null", () => {
		assert.equal(computeDisplayText("MyProject", null), "Claude Orchestrator");
	});

	it("returns project #1 for -1 numbered session", () => {
		assert.equal(computeDisplayText("15_Claude_Orchestrator", "15_Claude_Orchestrator-1"), "15_Claude_Orchestrator #1");
	});

	it("returns project name for legacy bare session name", () => {
		assert.equal(computeDisplayText("15_Claude_Orchestrator", "15_Claude_Orchestrator"), "15_Claude_Orchestrator");
	});

	it("returns project #N for numbered session", () => {
		assert.equal(computeDisplayText("15_Claude_Orchestrator", "15_Claude_Orchestrator-2"), "15_Claude_Orchestrator #2");
	});

	it("handles double-digit session numbers", () => {
		assert.equal(computeDisplayText("15_Claude_Orchestrator", "15_Claude_Orchestrator-10"), "15_Claude_Orchestrator #10");
	});

	it("returns project name for vault root project", () => {
		assert.equal(computeDisplayText("ClaudeRoot", "ClaudeRoot"), "ClaudeRoot");
	});

	it("returns project #N for vault root numbered session", () => {
		assert.equal(computeDisplayText("ClaudeRoot", "ClaudeRoot-2"), "ClaudeRoot #2");
	});
});

// --- restorableSessionNames ---

describe("restorableSessionNames", () => {
	const mkSession = (name: string, hasPanel: boolean): import("../src/utils.ts").SessionInfo => ({
		name,
		hasPanel,
		hasNote: true,
		queueCount: 0,
		lastActivity: null,
	});

	it("returns empty array when all sessions have panels", () => {
		const group = {
			project: "proj",
			sessions: [mkSession("proj", true), mkSession("proj-2", true)],
		};
		assert.deepEqual(restorableSessionNames(group), []);
	});

	it("returns names of sessions without panels", () => {
		const group = {
			project: "proj",
			sessions: [
				mkSession("proj", true),
				mkSession("proj-2", false),
				mkSession("proj-3", false),
			],
		};
		assert.deepEqual(restorableSessionNames(group), ["proj-2", "proj-3"]);
	});

	it("returns all names when no sessions have panels", () => {
		const group = {
			project: "proj",
			sessions: [mkSession("proj", false), mkSession("proj-2", false)],
		};
		assert.deepEqual(restorableSessionNames(group), ["proj", "proj-2"]);
	});

	it("returns empty array for group with no sessions", () => {
		const group = { project: "proj", sessions: [] };
		assert.deepEqual(restorableSessionNames(group), []);
	});
});

// ---------------------------------------------------------------------------
// Quick Reply
// ---------------------------------------------------------------------------

describe("QUICK_REPLY_KEYS", () => {
	it("contains expected default keys", () => {
		assert.deepEqual([...QUICK_REPLY_KEYS], ["1", "2", "Y", "{C-c}"]);
	});

	it("all keys are non-empty strings", () => {
		for (const k of QUICK_REPLY_KEYS) {
			assert.ok(k.length > 0, `key "${k}" should be non-empty`);
		}
	});
});

describe("buildQuickReplyTmuxArgs", () => {
	it("builds correct text and enter args", () => {
		const result = buildQuickReplyTmuxArgs("my-session", "Y");
		assert.deepEqual(result.textArgs, ["send-keys", "-l", "-t", "my-session", "Y"]);
		assert.deepEqual(result.enterArgs, ["send-keys", "-t", "my-session", "Enter"]);
	});

	it("uses -l flag for literal text", () => {
		const result = buildQuickReplyTmuxArgs("test", "1");
		assert.ok(result.textArgs.includes("-l"));
	});

	it("targets the correct session", () => {
		const result = buildQuickReplyTmuxArgs("15_Claude_Orchestrator-2", "2");
		assert.ok(result.textArgs.includes("15_Claude_Orchestrator-2"));
		assert.ok(result.enterArgs.includes("15_Claude_Orchestrator-2"));
	});
});

// --- cancelCopyModeArgs ---

describe("cancelCopyModeArgs", () => {
	it("builds correct cancel args for a session", () => {
		const args = cancelCopyModeArgs("15_Claude_Orchestrator");
		assert.deepEqual(args, ["send-keys", "-t", "15_Claude_Orchestrator", "-X", "cancel"]);
	});

	it("targets the correct session name", () => {
		const args = cancelCopyModeArgs("my-session-3");
		assert.ok(args.includes("my-session-3"));
		assert.ok(args.includes("-X"));
		assert.ok(args.includes("cancel"));
	});
});

// --- QueueMode helpers ---

describe("nextQueueMode", () => {
	it("cycles manual → listen → auto → manual", () => {
		assert.equal(nextQueueMode("manual"), "listen");
		assert.equal(nextQueueMode("listen"), "auto");
		assert.equal(nextQueueMode("auto"), "manual");
	});
});

describe("queueModeLabel", () => {
	it("returns human-readable labels", () => {
		assert.equal(queueModeLabel("manual"), "Manual");
		assert.equal(queueModeLabel("listen"), "Listen");
		assert.equal(queueModeLabel("auto"), "Auto");
	});
});

describe("queueModeTooltip", () => {
	it("includes mode description and next mode hint", () => {
		assert.ok(queueModeTooltip("manual").includes("Manual"));
		assert.ok(queueModeTooltip("manual").includes("Listen"));
		assert.ok(queueModeTooltip("listen").includes("Listen"));
		assert.ok(queueModeTooltip("listen").includes("Auto"));
		assert.ok(queueModeTooltip("auto").includes("Auto"));
		assert.ok(queueModeTooltip("auto").includes("Manual"));
	});
});

describe("QUEUE_MODES", () => {
	it("contains all three modes", () => {
		assert.deepEqual([...QUEUE_MODES], ["manual", "listen", "auto"]);
	});
});

describe("parseSessionNote queueMode", () => {
	it("defaults to manual when queueMode is absent", () => {
		const note = parseSessionNote("---\nsession: test\nstatus: idle\n---\n\n## History\n\n## Queue\n");
		assert.equal(note.queueMode, "manual");
	});

	it("parses queueMode from frontmatter", () => {
		const note = parseSessionNote("---\nsession: test\nstatus: idle\nqueueMode: auto\n---\n\n## History\n\n## Queue\n");
		assert.equal(note.queueMode, "auto");
	});

	it("ignores invalid queueMode values", () => {
		const note = parseSessionNote("---\nsession: test\nstatus: idle\nqueueMode: turbo\n---\n\n## History\n\n## Queue\n");
		assert.equal(note.queueMode, "manual");
	});

	it("round-trips queueMode through serialize", () => {
		const note = parseSessionNote("---\nsession: test\nstatus: idle\nqueueMode: listen\n---\n\n## History\n\n## Queue\n");
		const serialized = serializeSessionNote(note);
		const reparsed = parseSessionNote(serialized);
		assert.equal(reparsed.queueMode, "listen");
	});
});

describe("createDefaultSessionNote queueMode", () => {
	it("includes queueMode: manual in default note", () => {
		const content = createDefaultSessionNote("test-session");
		assert.ok(content.includes("queueMode: manual"));
		const parsed = parseSessionNote(content);
		assert.equal(parsed.queueMode, "manual");
	});
});

// ---------------------------------------------------------------------------
// PTY usage (dashboard)
// ---------------------------------------------------------------------------

describe("parsePtyMax", () => {
	it("parses a valid sysctl output", () => {
		assert.equal(parsePtyMax("511\n"), 511);
	});

	it("parses output with trailing whitespace", () => {
		assert.equal(parsePtyMax("  999  \n"), 999);
	});

	it("returns 0 for empty string", () => {
		assert.equal(parsePtyMax(""), 0);
	});

	it("returns 0 for non-numeric output", () => {
		assert.equal(parsePtyMax("error: not found"), 0);
	});

	it("handles large values", () => {
		assert.equal(parsePtyMax("2048"), 2048);
	});
});

describe("ptyLevel", () => {
	it("returns 'ok' when usage is below 70%", () => {
		assert.equal(ptyLevel(100, 511), "ok");
	});

	it("returns 'ok' at 69%", () => {
		assert.equal(ptyLevel(352, 511), "ok"); // 352/511 ≈ 68.9%
	});

	it("returns 'warning' at exactly 70%", () => {
		// 70% of 100 = 70
		assert.equal(ptyLevel(70, 100), "warning");
	});

	it("returns 'warning' between 70% and 90%", () => {
		assert.equal(ptyLevel(400, 511), "warning"); // 400/511 ≈ 78.3%
	});

	it("returns 'critical' at exactly 90%", () => {
		assert.equal(ptyLevel(90, 100), "critical");
	});

	it("returns 'critical' above 90%", () => {
		assert.equal(ptyLevel(480, 511), "critical"); // 480/511 ≈ 93.9%
	});

	it("returns 'ok' when max is 0 (unknown)", () => {
		assert.equal(ptyLevel(50, 0), "ok");
	});

	it("returns 'ok' when max is negative", () => {
		assert.equal(ptyLevel(50, -1), "ok");
	});

	it("returns 'critical' at 100%", () => {
		assert.equal(ptyLevel(511, 511), "critical");
	});

	it("thresholds match exported constants", () => {
		assert.equal(PTY_THRESHOLD_WARNING, 0.7);
		assert.equal(PTY_THRESHOLD_CRITICAL, 0.9);
	});
});

// ---------------------------------------------------------------------------
// Idle session detection
// ---------------------------------------------------------------------------

describe("isSessionIdle", () => {
	// 24 hours in ms
	const DAY_MS = 24 * 60 * 60 * 1000;

	it("returns false for recently active session", () => {
		const nowMs = Date.now();
		const recentEpochSecs = Math.floor(nowMs / 1000) - 3600; // 1 hour ago
		assert.equal(isSessionIdle(recentEpochSecs, nowMs), false);
	});

	it("returns true for session idle > 24 hours", () => {
		const nowMs = Date.now();
		const oldEpochSecs = Math.floor(nowMs / 1000) - (25 * 3600); // 25 hours ago
		assert.equal(isSessionIdle(oldEpochSecs, nowMs), true);
	});

	it("returns true at exactly 24 hours", () => {
		const nowMs = 1776317847000; // fixed reference
		const exactlyOneDayAgo = Math.floor((nowMs - DAY_MS) / 1000);
		assert.equal(isSessionIdle(exactlyOneDayAgo, nowMs), true);
	});

	it("returns false just under 24 hours", () => {
		const nowMs = 1776317847000;
		const justUnder = Math.floor((nowMs - DAY_MS + 60000) / 1000); // 24h minus 1 minute
		assert.equal(isSessionIdle(justUnder, nowMs), false);
	});

	it("returns false when activity is 0 (no data)", () => {
		assert.equal(isSessionIdle(0, Date.now()), false);
	});

	it("uses custom threshold", () => {
		const nowMs = Date.now();
		const twoHoursAgo = Math.floor(nowMs / 1000) - 7200;
		const oneHourMs = 3600 * 1000;
		assert.equal(isSessionIdle(twoHoursAgo, nowMs, oneHourMs), true);
		assert.equal(isSessionIdle(twoHoursAgo, nowMs, 3 * 3600 * 1000), false);
	});

	it("uses Date.now() when nowMs not provided", () => {
		const veryOld = 1000000000; // ~2001
		assert.equal(isSessionIdle(veryOld), true);
	});

	it("IDLE_THRESHOLD_MS is 24 hours", () => {
		assert.equal(IDLE_THRESHOLD_MS, 24 * 60 * 60 * 1000);
	});
});

// ---------------------------------------------------------------------------
// groupSessionsByProject includes tmuxActivity
// ---------------------------------------------------------------------------

describe("groupSessionsByProject tmuxActivity", () => {
	it("passes tmux activity timestamp into SessionInfo", () => {
		const sessions = [
			{ name: "15_Claude_Orchestrator", activity: 1776317847 },
		];
		const groups = groupSessionsByProject(
			sessions,
			new Set(),
			new Map(),
			TEST_PROJECTS,
		);
		const orch = groups.find((g) => g.project === "15_Claude_Orchestrator")!;
		assert.equal(orch.sessions[0].tmuxActivity, 1776317847);
	});

	it("defaults tmuxActivity to 0 for sessions without activity data", () => {
		const sessions = [
			{ name: "15_Claude_Orchestrator", activity: 0 },
		];
		const groups = groupSessionsByProject(
			sessions,
			new Set(),
			new Map(),
			TEST_PROJECTS,
		);
		const orch = groups.find((g) => g.project === "15_Claude_Orchestrator")!;
		assert.equal(orch.sessions[0].tmuxActivity, 0);
	});
});

// ---------------------------------------------------------------------------
// Stop hook signal
// ---------------------------------------------------------------------------

describe("STOP_SIGNAL_DIR", () => {
	it("is /tmp/co-stop", () => {
		assert.equal(STOP_SIGNAL_DIR, "/tmp/co-stop");
	});
});

describe("stopSignalFileName", () => {
	it("builds filename from timestamp and session name", () => {
		const name = stopSignalFileName("15_Claude_Orchestrator-1", 1700000000);
		assert.equal(name, "1700000000-15_Claude_Orchestrator-1.json");
	});

	it("works with simple session names", () => {
		const name = stopSignalFileName("myproject-2", 123);
		assert.equal(name, "123-myproject-2.json");
	});
});

describe("parseStopSignal", () => {
	it("parses valid signal JSON", () => {
		const json = JSON.stringify({
			tmux_session: "15_Claude_Orchestrator-1",
			session_id: "abc123",
			transcript_path: "/tmp/transcript.jsonl",
			cwd: "/Users/me/code/proj",
			timestamp: 1700000000,
		});
		const result = parseStopSignal(json);
		assert.ok(result);
		assert.equal(result.tmuxSession, "15_Claude_Orchestrator-1");
		assert.equal(result.sessionId, "abc123");
		assert.equal(result.transcriptPath, "/tmp/transcript.jsonl");
		assert.equal(result.cwd, "/Users/me/code/proj");
		assert.equal(result.timestamp, 1700000000);
	});

	it("returns null for empty string", () => {
		assert.equal(parseStopSignal(""), null);
	});

	it("returns null for invalid JSON", () => {
		assert.equal(parseStopSignal("{not json"), null);
	});

	it("returns null when tmux_session is missing", () => {
		const json = JSON.stringify({
			session_id: "abc",
			cwd: "/tmp",
			timestamp: 123,
		});
		assert.equal(parseStopSignal(json), null);
	});

	it("returns null when tmux_session is not a string", () => {
		const json = JSON.stringify({
			tmux_session: 123,
			session_id: "abc",
			timestamp: 123,
		});
		assert.equal(parseStopSignal(json), null);
	});

	it("handles missing optional fields gracefully", () => {
		const json = JSON.stringify({
			tmux_session: "proj-1",
			timestamp: 100,
		});
		const result = parseStopSignal(json);
		assert.ok(result);
		assert.equal(result.tmuxSession, "proj-1");
		assert.equal(result.sessionId, null);
		assert.equal(result.transcriptPath, null);
		assert.equal(result.cwd, null);
		assert.equal(result.timestamp, 100);
	});

	it("returns null when timestamp is missing", () => {
		const json = JSON.stringify({
			tmux_session: "proj-1",
			session_id: "abc",
		});
		assert.equal(parseStopSignal(json), null);
	});
});

// ---------------------------------------------------------------------------
// PTY budget (pre-spawn check)
// ---------------------------------------------------------------------------

describe("getPtyStatus", () => {
	it("returns 'ok' when usage is low", () => {
		assert.equal(getPtyStatus({ used: 100, max: 511 }), "ok");
	});

	it("returns 'ok' at exactly the threshold boundary", () => {
		const boundary = Math.floor(511 * PTY_WARNING_THRESHOLD);
		assert.equal(getPtyStatus({ used: boundary, max: 511 }), "ok");
	});

	it("returns 'warning' when above 90%", () => {
		const aboveThreshold = Math.floor(511 * PTY_WARNING_THRESHOLD) + 1;
		assert.equal(getPtyStatus({ used: aboveThreshold, max: 511 }), "warning");
	});

	it("returns 'exhausted' when used equals max", () => {
		assert.equal(getPtyStatus({ used: 511, max: 511 }), "exhausted");
	});

	it("returns 'exhausted' when used exceeds max", () => {
		assert.equal(getPtyStatus({ used: 520, max: 511 }), "exhausted");
	});

	it("returns 'exhausted' when both are zero", () => {
		assert.equal(getPtyStatus({ used: 0, max: 0 }), "exhausted");
	});

	it("returns 'ok' for zero used with positive max", () => {
		assert.equal(getPtyStatus({ used: 0, max: 511 }), "ok");
	});
});

describe("ptyStatusMessage", () => {
	it("returns empty string for ok status", () => {
		assert.equal(ptyStatusMessage({ used: 100, max: 511 }, "ok"), "");
	});

	it("includes usage counts for warning", () => {
		const msg = ptyStatusMessage({ used: 480, max: 511 }, "warning");
		assert.ok(msg.includes("480"), "should include used count");
		assert.ok(msg.includes("511"), "should include max count");
	});

	it("includes usage counts for exhausted", () => {
		const msg = ptyStatusMessage({ used: 511, max: 511 }, "exhausted");
		assert.ok(msg.includes("511"), "should include count");
	});

	it("warning and exhausted messages are different", () => {
		const warning = ptyStatusMessage({ used: 480, max: 511 }, "warning");
		const exhausted = ptyStatusMessage({ used: 511, max: 511 }, "exhausted");
		assert.notEqual(warning, exhausted);
	});
});

describe("parsePtyUsed", () => {
	it("parses valid wc output", () => {
		assert.equal(parsePtyUsed("  42\n"), 42);
	});

	it("parses zero", () => {
		assert.equal(parsePtyUsed("0\n"), 0);
	});

	it("returns 0 for empty string", () => {
		assert.equal(parsePtyUsed(""), 0);
	});

	it("returns 0 for non-numeric output", () => {
		assert.equal(parsePtyUsed("error"), 0);
	});

	it("returns 0 for negative number", () => {
		assert.equal(parsePtyUsed("-1"), 0);
	});

	it("parses large numbers", () => {
		assert.equal(parsePtyUsed("511"), 511);
	});
});

describe("PTY_WARNING_THRESHOLD", () => {
	it("is 0.9", () => {
		assert.equal(PTY_WARNING_THRESHOLD, 0.9);
	});
});

describe("PTY_DEFAULT_MAX", () => {
	it("is 511", () => {
		assert.equal(PTY_DEFAULT_MAX, 511);
	});
});

// ---------------------------------------------------------------------------
// extractSessionPreview
// ---------------------------------------------------------------------------

describe("extractSessionPreview", () => {
	const mkNote = (queue: string[], history: Array<{ text: string; completed: boolean }>, notes = "", summary = ""): SessionNote => ({
		session: "test",
		status: "idle",
		queueMode: "manual",
		displayName: "",
		summary,
		notes,
		history,
		queue,
	});

	it("returns last queue item when queue is non-empty", () => {
		const note = mkNote(
			["[2026-04-17 10:00] first task", "[2026-04-17 11:00] second task"],
			[{ text: "[2026-04-17 09:00] old history", completed: true }],
		);
		assert.equal(extractSessionPreview(note), "second task");
	});

	it("falls back to last history item when queue is empty", () => {
		const note = mkNote(
			[],
			[
				{ text: "[2026-04-16 09:00] done", completed: true },
				{ text: "[2026-04-16 10:00] latest history item", completed: false },
			],
		);
		assert.equal(extractSessionPreview(note), "latest history item");
	});

	it("returns null when both queue and history are empty", () => {
		const note = mkNote([], []);
		assert.equal(extractSessionPreview(note), null);
	});

	it("strips timestamp prefix from queue item", () => {
		const note = mkNote(["[2026-04-17 12:00] do the thing"], []);
		assert.equal(extractSessionPreview(note), "do the thing");
	});

	it("strips timestamp prefix from history item", () => {
		const note = mkNote([], [{ text: "[2026-04-17 12:00] did the thing", completed: true }]);
		assert.equal(extractSessionPreview(note), "did the thing");
	});

	it("returns first line only for multiline items", () => {
		const note = mkNote(["[2026-04-17 12:00] first line\nsecond line\nthird line"], []);
		assert.equal(extractSessionPreview(note), "first line");
	});

	it("handles items without timestamp prefix", () => {
		const note = mkNote(["plain text item"], []);
		assert.equal(extractSessionPreview(note), "plain text item");
	});

	it("handles history items without timestamp prefix", () => {
		const note = mkNote([], [{ text: "plain history", completed: false }]);
		assert.equal(extractSessionPreview(note), "plain history");
	});

	it("skips template line and returns actual content", () => {
		const note = mkNote([
			"[2026-04-17 12:00] 按照 [[Tasks_Convention#代码任务生命周期]] 执行以下任务。\n\n## 任务\n优化 Session Manager 卡片的预览",
		], []);
		assert.equal(extractSessionPreview(note), "优化 Session Manager 卡片的预览");
	});

	it("skips markdown headings", () => {
		const note = mkNote([
			"[2026-04-17 12:00] ## 任务\n实现拖拽排序",
		], []);
		assert.equal(extractSessionPreview(note), "实现拖拽排序");
	});

	it("skips multiple template/heading lines to find content", () => {
		const note = mkNote([
			"[2026-04-17 12:00] 按照 Tasks_Convention 执行。\n## 任务（合并 3 个改动）\n### 1. Quick Reply 按钮精简\n删除多余按钮",
		], []);
		assert.equal(extractSessionPreview(note), "删除多余按钮");
	});

	it("skips --- separator lines", () => {
		const note = mkNote(["[2026-04-17 12:00] ## 来源\n---\n修复 bug"], []);
		assert.equal(extractSessionPreview(note), "修复 bug");
	});

	it("falls back to first line when all lines are template", () => {
		const note = mkNote(["[2026-04-17 12:00] ## 任务\n## 来源\n## 参数"], []);
		assert.equal(extractSessionPreview(note), "## 任务");
	});

	it("skips empty lines between template and content", () => {
		const note = mkNote([
			"[2026-04-17 12:00] 按 Tasks_Convention 执行\n\n\n实际任务描述",
		], []);
		assert.equal(extractSessionPreview(note), "实际任务描述");
	});

	it("does not skip normal content that happens to start with 按", () => {
		const note = mkNote(["[2026-04-17 12:00] 按钮样式需要修改"], []);
		assert.equal(extractSessionPreview(note), "按钮样式需要修改");
	});

	it("ignores notes and shows queue item", () => {
		const note = mkNote(
			["[2026-04-17 10:00] queue item"],
			[{ text: "history item", completed: false }],
			"This session handles PTY management",
		);
		assert.equal(extractSessionPreview(note), "queue item");
	});

	it("ignores notes and shows history when queue is empty", () => {
		const note = mkNote([], [{ text: "history item", completed: false }], "Some notes content");
		assert.equal(extractSessionPreview(note), "history item");
	});

	it("returns null when only notes exist (no queue/history)", () => {
		const note = mkNote([], [], "Some notes");
		assert.equal(extractSessionPreview(note), null);
	});

	it("prioritizes summary over notes, queue, and history", () => {
		const note = mkNote(
			["[2026-04-17 10:00] queue item"],
			[{ text: "history item", completed: false }],
			"Notes content here",
			"PTY management session",
		);
		assert.equal(extractSessionPreview(note), "PTY management session");
	});

	it("does not fall back to notes when summary is empty", () => {
		const note = mkNote([], [], "Notes fallback", "");
		assert.equal(extractSessionPreview(note), null);
	});
});

// ---------------------------------------------------------------------------
// groupSessionsByProject passes preview
// ---------------------------------------------------------------------------

describe("groupSessionsByProject preview", () => {
	it("passes preview from noteData into SessionInfo", () => {
		const sessions = [
			{ name: "15_Claude_Orchestrator", activity: 100 },
		];
		const groups = groupSessionsByProject(
			sessions,
			new Set(),
			new Map([
				["15_Claude_Orchestrator", { queueCount: 1, lastActivity: null, preview: "task preview" }],
			]),
			TEST_PROJECTS,
		);
		const orch = groups.find((g) => g.project === "15_Claude_Orchestrator")!;
		assert.equal(orch.sessions[0].preview, "task preview");
	});

	it("defaults preview to null when noteData has no entry", () => {
		const sessions = [
			{ name: "15_Claude_Orchestrator", activity: 100 },
		];
		const groups = groupSessionsByProject(
			sessions,
			new Set(),
			new Map(),
			TEST_PROJECTS,
		);
		const orch = groups.find((g) => g.project === "15_Claude_Orchestrator")!;
		assert.equal(orch.sessions[0].preview, null);
	});
});

// --- SessionNote notes field ---

describe("parseSessionNote notes", () => {
	it("parses notes from ## Notes section", () => {
		const md = [
			"---", "session: test", "status: idle", "---", "",
			"## Notes", "This session handles PTY management", "",
			"## History", "", "## Queue", "",
		].join("\n");
		const note = parseSessionNote(md);
		assert.equal(note.notes, "This session handles PTY management");
	});

	it("parses multiline notes", () => {
		const md = [
			"---", "session: test", "status: idle", "---", "",
			"## Notes", "Line one", "Line two", "",
			"## History", "", "## Queue", "",
		].join("\n");
		const note = parseSessionNote(md);
		assert.equal(note.notes, "Line one\nLine two");
	});

	it("defaults to empty string when no Notes section", () => {
		const md = [
			"---", "session: test", "status: idle", "---", "",
			"## History", "", "## Queue", "",
		].join("\n");
		const note = parseSessionNote(md);
		assert.equal(note.notes, "");
	});

	it("round-trips notes through serialize", () => {
		const md = [
			"---", "session: test", "status: idle", "queueMode: manual", "pinnedNote: ", "---", "",
			"## Notes", "My important note", "",
			"## History", "", "## Queue", "",
		].join("\n");
		const note = parseSessionNote(md);
		assert.equal(note.notes, "My important note");
		const serialized = serializeSessionNote(note);
		const reparsed = parseSessionNote(serialized);
		assert.equal(reparsed.notes, "My important note");
	});
});

describe("parseSessionNote summary", () => {
	it("parses summary from frontmatter", () => {
		const md = "---\nsession: test\nsummary: PTY manager\n---\n\n## Notes\n\n## History\n\n## Queue\n";
		const note = parseSessionNote(md);
		assert.equal(note.summary, "PTY manager");
	});

	it("defaults summary to empty string when absent", () => {
		const md = "---\nsession: test\n---\n\n## Notes\n\n## History\n\n## Queue\n";
		const note = parseSessionNote(md);
		assert.equal(note.summary, "");
	});

	it("round-trips summary through serialize", () => {
		const md = "---\nsession: test\nsummary: My summary\n---\n\n## Notes\n\n## History\n\n## Queue\n";
		const note = parseSessionNote(md);
		assert.equal(note.summary, "My summary");
		const serialized = serializeSessionNote(note);
		const reparsed = parseSessionNote(serialized);
		assert.equal(reparsed.summary, "My summary");
	});

	it("omits summary from frontmatter when empty", () => {
		const md = "---\nsession: test\n---\n\n## Notes\n\n## History\n\n## Queue\n";
		const note = parseSessionNote(md);
		note.summary = "";
		const serialized = serializeSessionNote(note);
		assert.ok(!serialized.includes("summary:"));
	});
});

describe("createDefaultSessionNote notes", () => {
	it("includes empty ## Notes section", () => {
		const content = createDefaultSessionNote("test-session");
		assert.ok(content.includes("## Notes"));
		const parsed = parseSessionNote(content);
		assert.equal(parsed.notes, "");
	});
});

// ---------------------------------------------------------------------------
// bumpPatchVersion
// ---------------------------------------------------------------------------

describe("bumpPatchVersion", () => {
	it("bumps patch from 0.0.1 to 0.0.2", () => {
		assert.equal(bumpPatchVersion("0.0.1"), "0.0.2");
	});

	it("bumps patch from 1.2.3 to 1.2.4", () => {
		assert.equal(bumpPatchVersion("1.2.3"), "1.2.4");
	});

	it("bumps patch from 0.0.9 to 0.0.10", () => {
		assert.equal(bumpPatchVersion("0.0.9"), "0.0.10");
	});

	it("bumps patch from 1.0.0 to 1.0.1", () => {
		assert.equal(bumpPatchVersion("1.0.0"), "1.0.1");
	});

	it("handles large patch numbers", () => {
		assert.equal(bumpPatchVersion("0.1.99"), "0.1.100");
	});
});

// ---------------------------------------------------------------------------
// parseQueueItemSegments
// ---------------------------------------------------------------------------

describe("parseQueueItemSegments", () => {
	it("returns plain text as single segment", () => {
		const result = parseQueueItemSegments("hello world");
		assert.deepEqual(result, [{ type: "text", content: "hello world" }]);
	});

	it("parses wikilink image ![[name.png]]", () => {
		const result = parseQueueItemSegments("see ![[screenshot.png]] here");
		assert.deepEqual(result, [
			{ type: "text", content: "see " },
			{ type: "image", content: "screenshot.png" },
			{ type: "text", content: " here" },
		]);
	});

	it("parses markdown image ![alt](path)", () => {
		const result = parseQueueItemSegments("check ![photo](imgs/photo.jpg) done");
		assert.deepEqual(result, [
			{ type: "text", content: "check " },
			{ type: "image", content: "imgs/photo.jpg" },
			{ type: "text", content: " done" },
		]);
	});

	it("handles multiple images", () => {
		const result = parseQueueItemSegments("![[a.png]] and ![[b.jpg]]");
		assert.deepEqual(result, [
			{ type: "image", content: "a.png" },
			{ type: "text", content: " and " },
			{ type: "image", content: "b.jpg" },
		]);
	});

	it("handles image at start of text", () => {
		const result = parseQueueItemSegments("![[img.png]] is cool");
		assert.deepEqual(result, [
			{ type: "image", content: "img.png" },
			{ type: "text", content: " is cool" },
		]);
	});

	it("handles image at end of text", () => {
		const result = parseQueueItemSegments("look at ![[img.png]]");
		assert.deepEqual(result, [
			{ type: "text", content: "look at " },
			{ type: "image", content: "img.png" },
		]);
	});

	it("handles mixed wikilink and markdown images", () => {
		const result = parseQueueItemSegments("![[a.png]] and ![b](b.jpg)");
		assert.deepEqual(result, [
			{ type: "image", content: "a.png" },
			{ type: "text", content: " and " },
			{ type: "image", content: "b.jpg" },
		]);
	});

	it("returns empty array for empty string", () => {
		const result = parseQueueItemSegments("");
		assert.deepEqual(result, []);
	});

	it("handles wikilink with path", () => {
		const result = parseQueueItemSegments("![[attachments/screen shot.png]]");
		assert.deepEqual(result, [
			{ type: "image", content: "attachments/screen shot.png" },
		]);
	});

	it("does not match non-image wikilinks [[note]]", () => {
		const result = parseQueueItemSegments("see [[note]] here");
		assert.deepEqual(result, [{ type: "text", content: "see [[note]] here" }]);
	});

	it("only matches image extensions", () => {
		const result = parseQueueItemSegments("![[data.csv]] text");
		assert.deepEqual(result, [{ type: "text", content: "![[data.csv]] text" }]);
	});
});

// ---------------------------------------------------------------------------
// Done vs. Asking detection
// ---------------------------------------------------------------------------

describe("classifyStopReason", () => {
	it("returns 'done' for plain completion text", () => {
		assert.equal(classifyStopReason("I've made the changes. The tests pass."), "done");
	});

	it("returns 'done' for empty string", () => {
		assert.equal(classifyStopReason(""), "done");
	});

	it("returns 'asking' when text ends with a question mark", () => {
		assert.equal(classifyStopReason("Would you like me to proceed?"), "asking");
	});

	it("returns 'asking' for question mark at end of a line (not last line)", () => {
		assert.equal(classifyStopReason("Should I continue?\nLet me know."), "asking");
	});

	it("returns 'asking' for Y/n confirmation prompt", () => {
		assert.equal(classifyStopReason("Do you want to apply this change? (Y/n)"), "asking");
	});

	it("returns 'asking' for y/N confirmation prompt", () => {
		assert.equal(classifyStopReason("Proceed with deletion? (y/N)"), "asking");
	});

	it("returns 'asking' for numbered options", () => {
		const text = "Which approach do you prefer?\n1. Option A\n2. Option B\n3. Option C";
		assert.equal(classifyStopReason(text), "asking");
	});

	it("does not false-positive on question marks in code blocks", () => {
		const text = "I fixed the URL parsing.\n```\nconst url = `https://example.com/search?q=test`;\n```\nAll tests pass now.";
		assert.equal(classifyStopReason(text), "done");
	});

	it("does not false-positive on question marks in URLs mid-text", () => {
		assert.equal(classifyStopReason("Updated the endpoint https://api.example.com/v1?key=abc successfully."), "done");
	});

	it("only checks the tail of long text", () => {
		const longDone = "x".repeat(1000) + "\nAll done.";
		assert.equal(classifyStopReason(longDone), "done");
		const longAsk = "x".repeat(1000) + "\nShould I continue?";
		assert.equal(classifyStopReason(longAsk), "asking");
	});

	it("returns 'asking' for question with trailing whitespace", () => {
		assert.equal(classifyStopReason("Want me to fix this?  \n"), "asking");
	});

	it("returns 'done' for numbered list that is not options", () => {
		const text = "Here's what I changed:\n1. Fixed the bug\n2. Added tests\n3. Updated docs\n\nEverything looks good.";
		assert.equal(classifyStopReason(text), "done");
	});
});

describe("extractLastAssistantText", () => {
	it("extracts text from last assistant message", () => {
		const jsonl = [
			JSON.stringify({ type: "human", message: { role: "user", content: [{ type: "text", text: "Fix the bug" }] } }),
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I found the issue." }] } }),
		].join("\n");
		assert.equal(extractLastAssistantText(jsonl), "I found the issue.");
	});

	it("returns last assistant message when multiple exist", () => {
		const jsonl = [
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "First response" }] } }),
			JSON.stringify({ type: "human", message: { role: "user", content: [{ type: "text", text: "Do more" }] } }),
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Second response" }] } }),
		].join("\n");
		assert.equal(extractLastAssistantText(jsonl), "Second response");
	});

	it("joins multiple text content blocks", () => {
		const jsonl = JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Part one." },
					{ type: "tool_use", id: "t1", name: "bash", input: {} },
					{ type: "text", text: "Part two." },
				],
			},
		});
		assert.equal(extractLastAssistantText(jsonl), "Part one.\nPart two.");
	});

	it("returns null for empty input", () => {
		assert.equal(extractLastAssistantText(""), null);
	});

	it("returns null when no assistant messages exist", () => {
		const jsonl = JSON.stringify({ type: "human", message: { role: "user", content: [{ type: "text", text: "Hello" }] } });
		assert.equal(extractLastAssistantText(jsonl), null);
	});

	it("skips malformed JSON lines", () => {
		const jsonl = [
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Good" }] } }),
			"not valid json{{{",
		].join("\n");
		assert.equal(extractLastAssistantText(jsonl), "Good");
	});

	it("returns null when assistant message has no text content", () => {
		const jsonl = JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
			},
		});
		assert.equal(extractLastAssistantText(jsonl), null);
	});

	it("handles trailing newline in JSONL", () => {
		const jsonl = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }) + "\n";
		assert.equal(extractLastAssistantText(jsonl), "Done");
	});
});

describe("parseStopSignal with stop_reason", () => {
	it("parses stop_reason: done", () => {
		const json = JSON.stringify({
			tmux_session: "proj-1",
			timestamp: 100,
			stop_reason: "done",
		});
		const signal = parseStopSignal(json);
		assert.ok(signal);
		assert.equal(signal.stopReason, "done");
	});

	it("parses stop_reason: asking", () => {
		const json = JSON.stringify({
			tmux_session: "proj-1",
			timestamp: 100,
			stop_reason: "asking",
		});
		const signal = parseStopSignal(json);
		assert.ok(signal);
		assert.equal(signal.stopReason, "asking");
	});

	it("defaults stopReason to null when missing", () => {
		const json = JSON.stringify({
			tmux_session: "proj-1",
			timestamp: 100,
		});
		const signal = parseStopSignal(json);
		assert.ok(signal);
		assert.equal(signal.stopReason, null);
	});

	it("defaults stopReason to null for invalid value", () => {
		const json = JSON.stringify({
			tmux_session: "proj-1",
			timestamp: 100,
			stop_reason: "unknown",
		});
		const signal = parseStopSignal(json);
		assert.ok(signal);
		assert.equal(signal.stopReason, null);
	});
});

// ---------------------------------------------------------------------------
// autoSendAction
// ---------------------------------------------------------------------------

describe("autoSendAction", () => {
	it("returns 'none' for manual mode regardless of other params", () => {
		assert.equal(autoSendAction("manual", "done", 5), "none");
		assert.equal(autoSendAction("manual", "asking", 5), "none");
		assert.equal(autoSendAction("manual", null, 5), "none");
	});

	it("returns 'none' when stopReason is 'asking'", () => {
		assert.equal(autoSendAction("auto", "asking", 5), "none");
		assert.equal(autoSendAction("listen", "asking", 5), "none");
	});

	it("returns 'none' when queue is empty", () => {
		assert.equal(autoSendAction("auto", "done", 0), "none");
		assert.equal(autoSendAction("listen", "done", 0), "none");
	});

	it("returns 'send' for auto mode + done + queue non-empty", () => {
		assert.equal(autoSendAction("auto", "done", 3), "send");
	});

	it("returns 'send' for auto mode + null reason + queue non-empty", () => {
		assert.equal(autoSendAction("auto", null, 1), "send");
	});

	it("returns 'notify' for listen mode + done + queue non-empty", () => {
		assert.equal(autoSendAction("listen", "done", 2), "notify");
	});

	it("returns 'notify' for listen mode + null reason + queue non-empty", () => {
		assert.equal(autoSendAction("listen", null, 1), "notify");
	});
});

describe("AUTO_SEND_COUNTDOWN_MS", () => {
	it("is 3000ms", () => {
		assert.equal(AUTO_SEND_COUNTDOWN_MS, 3000);
	});
});


// --- SessionNote displayName ---

describe("parseSessionNote displayName", () => {
	it("defaults to empty string when no displayName", () => {
		const note = parseSessionNote("---\nsession: test\nstatus: idle\n---\n\n## Notes\n\n## History\n\n## Queue\n");
		assert.equal(note.displayName, "");
	});

	it("parses displayName from frontmatter", () => {
		const note = parseSessionNote("---\nsession: test\nstatus: idle\ndisplayName: My Custom Name\n---\n\n## Notes\n\n## History\n\n## Queue\n");
		assert.equal(note.displayName, "My Custom Name");
	});

	it("round-trips displayName through serialize", () => {
		const note = parseSessionNote("---\nsession: test\nstatus: idle\ndisplayName: PTY Manager\n---\n\n## Notes\n\n## History\n\n## Queue\n");
		const serialized = serializeSessionNote(note);
		const reparsed = parseSessionNote(serialized);
		assert.equal(reparsed.displayName, "PTY Manager");
	});

	it("omits displayName from frontmatter when empty", () => {
		const note = parseSessionNote("---\nsession: test\nstatus: idle\n---\n\n## Notes\n\n## History\n\n## Queue\n");
		const serialized = serializeSessionNote(note);
		assert.ok(!serialized.includes("displayName"));
	});
});

// ---------------------------------------------------------------------------
// ensureStopHookConfig
// ---------------------------------------------------------------------------

describe("ensureStopHookConfig", () => {
	const SCRIPT = "/path/to/plugins/claude-orchestrator/scripts/co-stop-hook.sh";

	const parse = (s: string) => JSON.parse(s) as Record<string, Record<string, Array<{ matcher: string; hooks: Array<{ command: string; timeout?: number }> }>>>;

	it("adds hook when settings has no hooks", () => {
		const result = ensureStopHookConfig(JSON.stringify({ model: "test" }), SCRIPT);
		assert.equal(result.updated, true);
		const parsed = parse(result.content);
		assert.equal(parsed.hooks.Stop.length, 1);
		assert.equal(parsed.hooks.Stop[0].hooks[0].command, SCRIPT);
		assert.equal(parsed.hooks.Stop[0].matcher, "*");
		assert.equal((parsed as unknown as Record<string, string>).model, "test");
	});

	it("adds hook when hooks exists but no Stop event", () => {
		const input = JSON.stringify({
			hooks: {
				SessionEnd: [{ matcher: "*", hooks: [{ type: "command", command: "other.sh" }] }],
			},
		});
		const result = ensureStopHookConfig(input, SCRIPT);
		assert.equal(result.updated, true);
		const parsed = parse(result.content);
		assert.ok(parsed.hooks.SessionEnd);
		assert.equal(parsed.hooks.Stop.length, 1);
	});

	it("adds hook when Stop exists but doesn't reference our script", () => {
		const input = JSON.stringify({
			hooks: {
				Stop: [{ matcher: "*", hooks: [{ type: "command", command: "/other/script.sh" }] }],
			},
		});
		const result = ensureStopHookConfig(input, SCRIPT);
		assert.equal(result.updated, true);
		const parsed = parse(result.content);
		assert.equal(parsed.hooks.Stop.length, 2);
	});

	it("does not add when co-stop-hook.sh already registered", () => {
		const input = JSON.stringify({
			hooks: {
				Stop: [{ matcher: "*", hooks: [{ type: "command", command: "/old/path/co-stop-hook.sh", timeout: 10 }] }],
			},
		});
		const result = ensureStopHookConfig(input, SCRIPT);
		assert.equal(result.updated, false);
	});

	it("preserves all existing settings", () => {
		const input = JSON.stringify({
			model: "opus",
			permissions: { allow: ["Bash(git:*)"] },
			hooks: { SessionEnd: [{ matcher: "*", hooks: [] }] },
		});
		const result = ensureStopHookConfig(input, SCRIPT);
		assert.equal(result.updated, true);
		const parsed = parse(result.content);
		assert.equal((parsed as unknown as Record<string, string>).model, "opus");
		assert.deepEqual((parsed as unknown as Record<string, Record<string, string[]>>).permissions, { allow: ["Bash(git:*)"] });
		assert.ok(parsed.hooks.SessionEnd);
	});

	it("returns unchanged for malformed JSON", () => {
		const result = ensureStopHookConfig("not json {{{", SCRIPT);
		assert.equal(result.updated, false);
		assert.equal(result.content, "not json {{{");
	});

	it("sets timeout to 10", () => {
		const result = ensureStopHookConfig("{}", SCRIPT);
		const parsed = parse(result.content);
		assert.equal(parsed.hooks.Stop[0].hooks[0].timeout, 10);
	});

	it("handles empty string input", () => {
		const result = ensureStopHookConfig("", SCRIPT);
		assert.equal(result.updated, false);
		assert.equal(result.content, "");
	});

	it("detects co-stop-hook.sh in nested matcher arrays", () => {
		const input = JSON.stringify({
			hooks: {
				Stop: [
					{ matcher: "project-a", hooks: [{ type: "command", command: "/a.sh" }] },
					{ matcher: "*", hooks: [
						{ type: "command", command: "/b.sh" },
						{ type: "command", command: "/somewhere/co-stop-hook.sh" },
					]},
				],
			},
		});
		const result = ensureStopHookConfig(input, SCRIPT);
		assert.equal(result.updated, false);
	});
});

// ---------------------------------------------------------------------------
// parseQuickReplyKeys
// ---------------------------------------------------------------------------

describe("parseQuickReplyKeys", () => {
	it("parses comma-separated keys", () => {
		assert.deepEqual(parseQuickReplyKeys("1, 2, Y"), ["1", "2", "Y"]);
	});

	it("trims whitespace", () => {
		assert.deepEqual(parseQuickReplyKeys("  A ,  B  , C "), ["A", "B", "C"]);
	});

	it("filters empty entries", () => {
		assert.deepEqual(parseQuickReplyKeys("1,,2,,,Y"), ["1", "2", "Y"]);
	});

	it("handles single key", () => {
		assert.deepEqual(parseQuickReplyKeys("Y"), ["Y"]);
	});

	it("returns empty array for empty string", () => {
		assert.deepEqual(parseQuickReplyKeys(""), []);
	});

	it("returns empty array for only commas", () => {
		assert.deepEqual(parseQuickReplyKeys(",,,"), []);
	});

	it("preserves multi-char keys", () => {
		assert.deepEqual(parseQuickReplyKeys("Yes, No, 1"), ["Yes", "No", "1"]);
	});
});

// ---------------------------------------------------------------------------
// Slash command autocomplete
// ---------------------------------------------------------------------------

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("is a non-empty array with command starting with /", () => {
		assert.ok(BUILTIN_SLASH_COMMANDS.length > 0);
		for (const entry of BUILTIN_SLASH_COMMANDS) {
			assert.ok(entry.command.startsWith("/"), `${entry.command} should start with /`);
			assert.ok(entry.description.length > 0, `${entry.command} should have description`);
		}
	});

	it("contains common commands", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((e) => e.command);
		assert.ok(names.includes("/help"));
		assert.ok(names.includes("/compact"));
		assert.ok(names.includes("/clear"));
	});

	it("is sorted alphabetically by command", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((e) => e.command);
		const sorted = [...names].sort();
		assert.deepEqual(names, sorted);
	});
});

describe("SLASH_COMMANDS (backward compat)", () => {
	it("is a string array of command names from builtins", () => {
		assert.ok(SLASH_COMMANDS.length > 0);
		for (const cmd of SLASH_COMMANDS) {
			assert.ok(cmd.startsWith("/"));
		}
	});
});

describe("parseSkillMd", () => {
	it("parses name and description from SKILL.md frontmatter", () => {
		const content = [
			"---",
			"name: my-skill",
			"description: Does something cool",
			"---",
			"",
			"Body content here.",
		].join("\n");
		const result = parseSkillMd(content);
		assert.deepEqual(result, { name: "my-skill", description: "Does something cool" });
	});

	it("returns null when name is missing", () => {
		const content = "---\ndescription: No name\n---\n";
		assert.equal(parseSkillMd(content), null);
	});

	it("returns null for empty content", () => {
		assert.equal(parseSkillMd(""), null);
	});

	it("returns null when no frontmatter", () => {
		assert.equal(parseSkillMd("just plain text"), null);
	});

	it("handles missing description gracefully", () => {
		const content = "---\nname: no-desc\n---\n";
		const result = parseSkillMd(content);
		assert.deepEqual(result, { name: "no-desc", description: "" });
	});

	it("handles extra whitespace in values", () => {
		const content = "---\nname:   spaced  \ndescription:  trim me  \n---\n";
		const result = parseSkillMd(content);
		assert.deepEqual(result, { name: "spaced", description: "trim me" });
	});

	it("handles real-world SKILL.md format", () => {
		const content = [
			"---",
			"name: allow-session",
			"description: Scan session history for Bash commands that needed approval and add them to ~/.claude/settings.json allow list",
			"---",
			"",
			"# Instructions",
			"...",
		].join("\n");
		const result = parseSkillMd(content);
		assert.equal(result!.name, "allow-session");
		assert.ok(result!.description.includes("Scan session"));
	});

	it("parses YAML multi-line >- description", () => {
		const content = [
			"---",
			"name: next-go",
			"description: >-",
			"  Analyze Input notes and dispatch parallel tasks.",
			"  Use for: next go, dispatch.",
			"---",
		].join("\n");
		const result = parseSkillMd(content);
		assert.equal(result!.name, "next-go");
		assert.ok(result!.description.includes("Analyze Input"));
		assert.ok(!result!.description.includes("Use for:"));
	});

	it("parses YAML multi-line | description", () => {
		const content = [
			"---",
			"name: test-skill",
			"description: |",
			"  Line one.",
			"  Line two.",
			"---",
		].join("\n");
		const result = parseSkillMd(content);
		assert.ok(result!.description.includes("Line one."));
		assert.ok(result!.description.includes("Line two."));
	});
});

describe("filterSlashCommands", () => {
	const testCmds: SlashCommandEntry[] = [
		{ command: "/clear", description: "Clear conversation" },
		{ command: "/compact", description: "Compact history" },
		{ command: "/cost", description: "Show cost" },
		{ command: "/help", description: "Show help" },
	];

	it("returns all commands for bare /", () => {
		const result = filterSlashCommands("/", testCmds);
		assert.equal(result.length, 4);
		assert.equal(result[0].command, "/clear");
	});

	it("filters by prefix", () => {
		const result = filterSlashCommands("/co", testCmds);
		assert.equal(result.length, 2);
		assert.ok(result.some((e) => e.command === "/compact"));
		assert.ok(result.some((e) => e.command === "/cost"));
	});

	it("is case-insensitive", () => {
		const result = filterSlashCommands("/HE", testCmds);
		assert.equal(result.length, 1);
		assert.equal(result[0].command, "/help");
	});

	it("returns empty for no matches", () => {
		assert.deepEqual(filterSlashCommands("/zzzzz", testCmds), []);
	});

	it("returns empty for non-slash input", () => {
		assert.deepEqual(filterSlashCommands("hello", testCmds), []);
	});

	it("returns empty for empty string", () => {
		assert.deepEqual(filterSlashCommands("", testCmds), []);
	});

	it("matches exact command", () => {
		const result = filterSlashCommands("/help", testCmds);
		assert.equal(result.length, 1);
		assert.equal(result[0].command, "/help");
	});

	it("handles / with trailing space as no match", () => {
		assert.deepEqual(filterSlashCommands("/ ", testCmds), []);
	});

	it("uses BUILTIN_SLASH_COMMANDS when no list provided", () => {
		const result = filterSlashCommands("/help");
		assert.ok(result.length >= 1);
		assert.equal(result[0].command, "/help");
	});
});

// --- applySortOrder ---

describe("applySortOrder", () => {
	it("returns items unchanged when order is empty", () => {
		const items = [{ name: "b" }, { name: "a" }];
		assert.deepEqual(applySortOrder(items, []), items);
	});

	it("sorts items by custom order", () => {
		const items = [{ name: "a" }, { name: "b" }, { name: "c" }];
		const result = applySortOrder(items, ["c", "a", "b"]);
		assert.deepEqual(result.map(i => i.name), ["c", "a", "b"]);
	});

	it("puts unknown items at end alphabetically", () => {
		const items = [{ name: "x" }, { name: "a" }, { name: "b" }];
		const result = applySortOrder(items, ["b"]);
		assert.deepEqual(result.map(i => i.name), ["b", "a", "x"]);
	});

	it("does not mutate original array", () => {
		const items = [{ name: "b" }, { name: "a" }];
		applySortOrder(items, ["a", "b"]);
		assert.equal(items[0]!.name, "b");
	});

	it("handles order with extra names not in items", () => {
		const items = [{ name: "a" }, { name: "b" }];
		const result = applySortOrder(items, ["z", "b", "a"]);
		assert.deepEqual(result.map(i => i.name), ["b", "a"]);
	});
});

// ---------------------------------------------------------------------------
// stripTimestamp
// ---------------------------------------------------------------------------

describe("stripTimestamp", () => {
	it("strips [YYYY-MM-DD HH:MM] prefix", () => {
		assert.equal(stripTimestamp("[2026-04-17 10:30] do the thing"), "do the thing");
	});

	it("returns text unchanged when no timestamp prefix", () => {
		assert.equal(stripTimestamp("plain text"), "plain text");
	});

	it("returns empty string for timestamp-only text", () => {
		assert.equal(stripTimestamp("[2026-04-17 10:30] "), "");
	});

	it("handles multiline — only strips first line prefix", () => {
		assert.equal(stripTimestamp("[2026-04-17 10:30] line1\nline2"), "line1\nline2");
	});

	it("returns empty string for empty input", () => {
		assert.equal(stripTimestamp(""), "");
	});
});

// --- handleTerminalScrollKey ---

describe("handleTerminalScrollKey", () => {
	it("scrolls up on PageUp and returns false", () => {
		const calls: number[] = [];
		const result = handleTerminalScrollKey("PageUp", (n) => calls.push(n));
		assert.equal(result, false);
		assert.deepStrictEqual(calls, [-1]);
	});

	it("scrolls down on PageDown and returns false", () => {
		const calls: number[] = [];
		const result = handleTerminalScrollKey("PageDown", (n) => calls.push(n));
		assert.equal(result, false);
		assert.deepStrictEqual(calls, [1]);
	});

	it("returns true and does not scroll for regular keys", () => {
		const calls: number[] = [];
		for (const key of ["a", "Enter", "ArrowUp", "ArrowDown", "Escape", "Tab"]) {
			assert.equal(handleTerminalScrollKey(key, (n) => calls.push(n)), true);
		}
		assert.deepStrictEqual(calls, []);
	});
});

// --- classifyAcKey ---

describe("classifyAcKey", () => {
	it("returns 'accept' for Enter without shift", () => {
		assert.equal(classifyAcKey("Enter", false), "accept");
	});

	it("returns null for Enter with shift", () => {
		assert.equal(classifyAcKey("Enter", true), null);
	});

	it("returns 'accept' for Tab without shift", () => {
		assert.equal(classifyAcKey("Tab", false), "accept");
	});

	it("returns null for Tab with shift", () => {
		assert.equal(classifyAcKey("Tab", true), null);
	});

	it("returns 'accept' for ArrowRight without shift", () => {
		assert.equal(classifyAcKey("ArrowRight", false), "accept");
	});

	it("returns 'close' for Escape", () => {
		assert.equal(classifyAcKey("Escape", false), "close");
	});

	it("returns 'next' for ArrowDown", () => {
		assert.equal(classifyAcKey("ArrowDown", false), "next");
	});

	it("returns 'prev' for ArrowUp", () => {
		assert.equal(classifyAcKey("ArrowUp", false), "prev");
	});

	it("returns null for unrelated keys", () => {
		for (const key of ["a", "Backspace", "ArrowLeft", "Home", "End"]) {
			assert.equal(classifyAcKey(key, false), null);
		}
	});
});

// --- allSessionNotePaths ---

describe("allSessionNotePaths", () => {
	it("builds paths for all project-session combinations", () => {
		const projects: ProjectRegistry = {
			"ProjectA": { vaultFolder: "01_Projects/ProjectA" },
		};
		const names = ["ProjectA-1", "ProjectA-2"];
		const paths = allSessionNotePaths(projects, names);
		assert.deepStrictEqual(paths, [
			"01_Projects/ProjectA/sessions/ProjectA-1.md",
			"01_Projects/ProjectA/sessions/ProjectA-2.md",
		]);
	});

	it("returns empty array for empty inputs", () => {
		assert.deepStrictEqual(allSessionNotePaths({}, []), []);
		assert.deepStrictEqual(
			allSessionNotePaths({ "A": { vaultFolder: "x" } }, []),
			[],
		);
	});
});

// --- wheelDeltaToLines ---

describe("wheelDeltaToLines", () => {
	it("converts pixel deltas (mode 0) to lines using 20px step", () => {
		assert.equal(wheelDeltaToLines(60, 0), 3);
		assert.equal(wheelDeltaToLines(-60, 0), -3);
		assert.equal(wheelDeltaToLines(100, 0), 5);
		assert.equal(wheelDeltaToLines(-100, 0), -5);
	});

	it("returns at least ±1 for small pixel deltas", () => {
		assert.equal(wheelDeltaToLines(5, 0), 1);
		assert.equal(wheelDeltaToLines(-5, 0), -1);
		assert.equal(wheelDeltaToLines(19, 0), 1);
		assert.equal(wheelDeltaToLines(-19, 0), -1);
	});

	it("returns 0 for zero delta", () => {
		assert.equal(wheelDeltaToLines(0, 0), 0);
		assert.equal(wheelDeltaToLines(0, 1), 0);
		assert.equal(wheelDeltaToLines(0, 2), 0);
	});

	it("passes through line deltas (mode 1) directly", () => {
		assert.equal(wheelDeltaToLines(3, 1), 3);
		assert.equal(wheelDeltaToLines(-3, 1), -3);
		assert.equal(wheelDeltaToLines(1, 1), 1);
	});

	it("multiplies page deltas (mode 2) by WHEEL_LINES_PER_PAGE", () => {
		assert.equal(wheelDeltaToLines(1, 2), WHEEL_LINES_PER_PAGE);
		assert.equal(wheelDeltaToLines(-1, 2), -WHEEL_LINES_PER_PAGE);
		assert.equal(wheelDeltaToLines(2, 2), 2 * WHEEL_LINES_PER_PAGE);
	});
});

// --- escapeLeadingBang ---

describe("escapeLeadingBang", () => {
	it("prepends space when text starts with !", () => {
		assert.equal(escapeLeadingBang("![[image.png]]"), " ![[image.png]]");
		assert.equal(escapeLeadingBang("! ls"), " ! ls");
		assert.equal(escapeLeadingBang("!!"), " !!");
	});

	it("returns text unchanged when it does not start with !", () => {
		assert.equal(escapeLeadingBang("hello !world"), "hello !world");
		assert.equal(escapeLeadingBang("normal text"), "normal text");
		assert.equal(escapeLeadingBang(" !already spaced"), " !already spaced");
	});

	it("returns empty string unchanged", () => {
		assert.equal(escapeLeadingBang(""), "");
	});
});

// --- pickRecoverySession ---

describe("pickRecoverySession", () => {
	it("picks the most recently active unclaimed session", () => {
		const sessions = [
			{ name: "15_Claude_Orchestrator-1", activity: 100 },
			{ name: "15_Claude_Orchestrator-2", activity: 200 },
		];
		const result = pickRecoverySession(sessions, TEST_PROJECTS, new Set());
		assert.deepStrictEqual(result, {
			project: "15_Claude_Orchestrator",
			sessionName: "15_Claude_Orchestrator-2",
		});
	});

	it("skips sessions already claimed by other views", () => {
		const sessions = [
			{ name: "15_Claude_Orchestrator-1", activity: 100 },
			{ name: "15_Claude_Orchestrator-2", activity: 200 },
		];
		const claimed = new Set(["15_Claude_Orchestrator-2"]);
		const result = pickRecoverySession(sessions, TEST_PROJECTS, claimed);
		assert.deepStrictEqual(result, {
			project: "15_Claude_Orchestrator",
			sessionName: "15_Claude_Orchestrator-1",
		});
	});

	it("returns null when all sessions are claimed", () => {
		const sessions = [
			{ name: "15_Claude_Orchestrator-1", activity: 100 },
		];
		const claimed = new Set(["15_Claude_Orchestrator-1"]);
		assert.equal(pickRecoverySession(sessions, TEST_PROJECTS, claimed), null);
	});

	it("returns null when no sessions match registered projects", () => {
		const sessions = [
			{ name: "unknown-project-1", activity: 100 },
		];
		assert.equal(pickRecoverySession(sessions, TEST_PROJECTS, new Set()), null);
	});

	it("returns null for empty session list", () => {
		assert.equal(pickRecoverySession([], TEST_PROJECTS, new Set()), null);
	});

	it("picks from multiple projects correctly", () => {
		const sessions = [
			{ name: "14_Mobile_Claude_Code-1", activity: 300 },
			{ name: "15_Claude_Orchestrator-1", activity: 100 },
		];
		const result = pickRecoverySession(sessions, TEST_PROJECTS, new Set());
		assert.deepStrictEqual(result, {
			project: "14_Mobile_Claude_Code",
			sessionName: "14_Mobile_Claude_Code-1",
		});
	});

	it("skips unregistered sessions even if more recent", () => {
		const sessions = [
			{ name: "unknown-session", activity: 999 },
			{ name: "15_Claude_Orchestrator-1", activity: 100 },
		];
		const result = pickRecoverySession(sessions, TEST_PROJECTS, new Set());
		assert.deepStrictEqual(result, {
			project: "15_Claude_Orchestrator",
			sessionName: "15_Claude_Orchestrator-1",
		});
	});
});

// --- sessionStatusDisplay ---

describe("sessionStatusDisplay", () => {
	it("returns running dot when panel active and running", () => {
		const r = sessionStatusDisplay(true, "running");
		assert.equal(r.dataStatus, "running");
		assert.equal(r.cls, "co-sm-status-dot");
	});

	it("returns waiting_for_user dot when waiting for user", () => {
		const r = sessionStatusDisplay(true, "waiting_for_user");
		assert.equal(r.dataStatus, "waiting_for_user");
		assert.equal(r.cls, "co-sm-status-dot");
	});

	it("returns idle dot when panel active and idle", () => {
		const r = sessionStatusDisplay(true, "idle");
		assert.equal(r.dataStatus, "idle");
		assert.equal(r.cls, "co-sm-status-dot");
	});

	it("returns off dot when no panel", () => {
		const r = sessionStatusDisplay(false, "running");
		assert.equal(r.dataStatus, "off");
		assert.equal(r.cls, "co-sm-status-dot");
	});

	it("defaults unknown status to idle", () => {
		const r = sessionStatusDisplay(true, "something_else");
		assert.equal(r.dataStatus, "idle");
	});
});

// --- terminalTheme ---

describe("terminalTheme", () => {
	it("returns Terminal theme colors", () => {
		const t = terminalTheme("terminal");
		assert.equal(t.background, "#06090a");
		assert.equal(t.foreground, "#d6d7c9");
	});

	it("returns Obsidian theme colors", () => {
		const t = terminalTheme("obsidian");
		assert.equal(t.background, "#16161a");
		assert.equal(t.foreground, "#dcddde");
	});
});

// --- migrateThemeName ---

describe("migrateThemeName", () => {
	it("migrates v1 to terminal", () => {
		assert.equal(migrateThemeName("v1"), "terminal");
	});

	it("migrates v2 to obsidian", () => {
		assert.equal(migrateThemeName("v2"), "obsidian");
	});

	it("keeps terminal as terminal", () => {
		assert.equal(migrateThemeName("terminal"), "terminal");
	});

	it("keeps obsidian as obsidian", () => {
		assert.equal(migrateThemeName("obsidian"), "obsidian");
	});

	it("defaults to obsidian for unknown values", () => {
		assert.equal(migrateThemeName("unknown"), "obsidian");
		assert.equal(migrateThemeName(null), "obsidian");
		assert.equal(migrateThemeName(undefined), "obsidian");
	});
});

// --- SessionLifecycle ---

describe("SessionLifecycle", () => {
	describe("initial state", () => {
		it("starts with gen 0, null project/session, clean", () => {
			const lc = new SessionLifecycle();
			assert.equal(lc.gen, 0);
			assert.equal(lc.project, null);
			assert.equal(lc.sessionName, null);
			assert.equal(lc.dirty, false);
		});
	});

	describe("beginSwitch", () => {
		it("increments generation on each switch", () => {
			const lc = new SessionLifecycle();
			const s1 = lc.beginSwitch("A", "A-1");
			assert.equal(s1.gen, 1);
			const s2 = lc.beginSwitch("B", "B-1");
			assert.equal(s2.gen, 2);
			const s3 = lc.beginSwitch("C", "C-1");
			assert.equal(s3.gen, 3);
		});

		it("updates project and sessionName", () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("ProjectA", "ProjectA-1");
			assert.equal(lc.project, "ProjectA");
			assert.equal(lc.sessionName, "ProjectA-1");
		});

		it("returns old project/session info", () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("A", "A-1");
			const s2 = lc.beginSwitch("B", "B-1");
			assert.equal(s2.oldProject, "A");
			assert.equal(s2.oldSessionName, "A-1");
		});

		it("returns null old values on first switch", () => {
			const lc = new SessionLifecycle();
			const s1 = lc.beginSwitch("A", "A-1");
			assert.equal(s1.oldProject, null);
			assert.equal(s1.oldSessionName, null);
		});

		it("reports needsSave=true when dirty", () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("A", "A-1");
			lc.markDirty();
			const s2 = lc.beginSwitch("B", "B-1");
			assert.equal(s2.needsSave, true);
		});

		it("reports needsSave=false when clean", () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("A", "A-1");
			const s2 = lc.beginSwitch("B", "B-1");
			assert.equal(s2.needsSave, false);
		});

		it("resets dirty flag after switch", () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("A", "A-1");
			lc.markDirty();
			assert.equal(lc.dirty, true);
			lc.beginSwitch("B", "B-1");
			assert.equal(lc.dirty, false);
		});

		it("handles switch to null project", () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("A", "A-1");
			const s2 = lc.beginSwitch(null, null);
			assert.equal(lc.project, null);
			assert.equal(lc.sessionName, null);
			assert.equal(s2.oldProject, "A");
		});
	});

	describe("isStale", () => {
		it("returns false for current generation", () => {
			const lc = new SessionLifecycle();
			const { gen } = lc.beginSwitch("A", "A-1");
			assert.equal(lc.isStale(gen), false);
		});

		it("returns true after another switch invalidates it", () => {
			const lc = new SessionLifecycle();
			const { gen: gen1 } = lc.beginSwitch("A", "A-1");
			lc.beginSwitch("B", "B-1");
			assert.equal(lc.isStale(gen1), true);
		});

		it("only the latest generation is current", () => {
			const lc = new SessionLifecycle();
			const { gen: g1 } = lc.beginSwitch("A", "A-1");
			const { gen: g2 } = lc.beginSwitch("B", "B-1");
			const { gen: g3 } = lc.beginSwitch("C", "C-1");
			assert.equal(lc.isStale(g1), true);
			assert.equal(lc.isStale(g2), true);
			assert.equal(lc.isStale(g3), false);
		});

		it("gen 0 is stale after any switch", () => {
			const lc = new SessionLifecycle();
			assert.equal(lc.isStale(0), false);
			lc.beginSwitch("A", "A-1");
			assert.equal(lc.isStale(0), true);
		});
	});

	describe("captureTarget", () => {
		it("returns current sessionName", () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("A", "A-1");
			assert.equal(lc.captureTarget(), "A-1");
		});

		it("returns null before any switch", () => {
			const lc = new SessionLifecycle();
			assert.equal(lc.captureTarget(), null);
		});

		it("captured value is immutable — does not change after switch", () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("A", "A-1");
			const target = lc.captureTarget();
			lc.beginSwitch("B", "B-1");
			assert.equal(target, "A-1");
			assert.equal(lc.captureTarget(), "B-1");
		});
	});

	describe("dirty tracking", () => {
		it("markDirty sets dirty to true", () => {
			const lc = new SessionLifecycle();
			lc.markDirty();
			assert.equal(lc.dirty, true);
		});

		it("markClean sets dirty to false", () => {
			const lc = new SessionLifecycle();
			lc.markDirty();
			lc.markClean();
			assert.equal(lc.dirty, false);
		});

		it("multiple markDirty calls are idempotent", () => {
			const lc = new SessionLifecycle();
			lc.markDirty();
			lc.markDirty();
			assert.equal(lc.dirty, true);
		});
	});

	describe("flush (in-flight save tracking)", () => {
		it("resolves immediately when no save is in flight", async () => {
			const lc = new SessionLifecycle();
			await lc.flush();
		});

		it("waits for tracked save to complete", async () => {
			const lc = new SessionLifecycle();
			let resolved = false;
			const savePromise = new Promise<void>((resolve) => {
				setTimeout(() => { resolved = true; resolve(); }, 10);
			});
			lc.trackSave(savePromise);
			assert.equal(resolved, false);
			await lc.flush();
			assert.equal(resolved, true);
		});

		it("clears tracked save after completion", async () => {
			const lc = new SessionLifecycle();
			let callCount = 0;
			const savePromise = new Promise<void>((resolve) => {
				callCount++;
				resolve();
			});
			lc.trackSave(savePromise);
			await lc.flush();
			assert.equal(callCount, 1);
			await lc.flush();
		});

		it("handles rejected saves without throwing from flush", async () => {
			const lc = new SessionLifecycle();
			lc.trackSave(Promise.reject(new Error("write failed")));
			await lc.flush();
		});

		it("tracks only the latest save when multiple are registered", async () => {
			const lc = new SessionLifecycle();
			const order: string[] = [];
			const save1 = new Promise<void>((resolve) => {
				setTimeout(() => { order.push("save1"); resolve(); }, 20);
			});
			const save2 = new Promise<void>((resolve) => {
				setTimeout(() => { order.push("save2"); resolve(); }, 5);
			});
			lc.trackSave(save1);
			lc.trackSave(save2);
			await lc.flush();
			assert.ok(order.includes("save2"));
		});
	});

	describe("lifecycle scenarios", () => {
		it("project switch: save-before-switch flow", () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("A", "A-1");
			lc.markDirty();

			const switchResult = lc.beginSwitch("B", "B-1");
			assert.equal(switchResult.needsSave, true);
			assert.equal(switchResult.oldProject, "A");
			assert.equal(switchResult.oldSessionName, "A-1");
			assert.equal(lc.project, "B");
			assert.equal(lc.sessionName, "B-1");
			assert.equal(lc.dirty, false);
		});

		it("rapid switch: first load is stale, second is current", () => {
			const lc = new SessionLifecycle();
			const { gen: g1 } = lc.beginSwitch("A", "A-1");
			const { gen: g2 } = lc.beginSwitch("B", "B-1");
			assert.equal(lc.isStale(g1), true);
			assert.equal(lc.isStale(g2), false);
		});

		it("tab close: flush waits for save then allows cleanup", async () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("A", "A-1");
			lc.markDirty();

			let saved = false;
			lc.trackSave(new Promise<void>((resolve) => {
				setTimeout(() => { saved = true; resolve(); }, 10);
			}));

			await lc.flush();
			assert.equal(saved, true);
		});

		it("sendMessage: captured target survives project switch", () => {
			const lc = new SessionLifecycle();
			lc.beginSwitch("A", "A-1");

			const target = lc.captureTarget();
			const gen = lc.gen;

			lc.beginSwitch("B", "B-1");

			assert.equal(target, "A-1");
			assert.equal(lc.isStale(gen), true);
			assert.equal(lc.captureTarget(), "B-1");
		});
	});
});

// --- pinnedNote removal ---

describe("pinnedNote removal", () => {
	it("serializeSessionNote does not include pinnedNote in frontmatter", () => {
		const note: SessionNote = {
			session: "test",
			status: "idle" as const,
			queueMode: "manual" as const,
			displayName: "",
			summary: "",
			notes: "",
			history: [],
			queue: [],
		};
		const result = serializeSessionNote(note);
		const lines = result.split("\n");
		const hasPinnedNote = lines.some((l) => l.startsWith("pinnedNote:"));
		assert.ok(!hasPinnedNote, "serialized note should not contain pinnedNote field");
	});

	it("parseSessionNote handles legacy pinnedNote frontmatter gracefully", () => {
		const md = [
			"---",
			"session: legacy",
			"status: running",
			"pinnedNote: 01_Projects/old/note.md",
			"queueMode: auto",
			"---",
			"",
			"## Notes",
			"some notes",
			"",
			"## History",
			"- [ ] [2026-04-18 10:00] task",
			"",
			"## Queue",
			"- [2026-04-18 11:00] next",
			"",
		].join("\n");
		const note = parseSessionNote(md, "legacy");
		assert.equal(note.session, "legacy");
		assert.equal(note.status, "running");
		assert.equal(note.queueMode, "auto");
		assert.equal(note.notes, "some notes");
		assert.equal(note.history.length, 1);
		assert.equal(note.queue.length, 1);
	});

	it("round-trip serialization drops pinnedNote from legacy notes", () => {
		const md = [
			"---",
			"session: test-rt",
			"status: idle",
			"pinnedNote: old/path.md",
			"queueMode: manual",
			"---",
			"",
			"## Notes",
			"",
			"## History",
			"",
			"## Queue",
			"",
		].join("\n");
		const note = parseSessionNote(md, "test-rt");
		const serialized = serializeSessionNote(note);
		assert.ok(!serialized.includes("pinnedNote:"), "re-serialized note should drop pinnedNote");
	});
});

// --- quickReplyLabel ---

describe("quickReplyLabel", () => {
	it("returns plain text keys unchanged", () => {
		assert.equal(quickReplyLabel("Y"), "Y");
		assert.equal(quickReplyLabel("1"), "1");
	});

	it("converts {C-c} to ^C", () => {
		assert.equal(quickReplyLabel("{C-c}"), "^C");
	});

	it("converts {C-d} to ^D", () => {
		assert.equal(quickReplyLabel("{C-d}"), "^D");
	});

	it("returns tmux key name for non-Ctrl sequences", () => {
		assert.equal(quickReplyLabel("{Escape}"), "Escape");
	});
});

// --- buildQuickReplyTmuxArgs with key sequences ---

describe("buildQuickReplyTmuxArgs key sequences", () => {
	it("uses send-keys without -l for {C-c}", () => {
		const result = buildQuickReplyTmuxArgs("session", "{C-c}");
		assert.deepEqual(result.textArgs, ["send-keys", "-t", "session", "C-c"]);
		assert.ok(!result.textArgs.includes("-l"));
	});

	it("does not send Enter for key sequences", () => {
		const result = buildQuickReplyTmuxArgs("session", "{C-c}");
		assert.deepEqual(result.enterArgs, []);
	});

	it("still uses -l and Enter for plain text", () => {
		const result = buildQuickReplyTmuxArgs("session", "Y");
		assert.ok(result.textArgs.includes("-l"));
		assert.deepEqual(result.enterArgs, ["send-keys", "-t", "session", "Enter"]);
	});
});

describe("unregisterConfirmText", () => {
	it("mentions session count when sessions exist", () => {
		const text = unregisterConfirmText(3);
		assert.ok(text.includes("3"));
		assert.ok(text.toLowerCase().includes("unmanaged"));
	});

	it("returns simple confirmation when no sessions", () => {
		const text = unregisterConfirmText(0);
		assert.ok(!text.includes("0"));
		assert.ok(text.toLowerCase().includes("unregister"));
	});

	it("uses singular for 1 session", () => {
		const text = unregisterConfirmText(1);
		assert.ok(text.includes("1"));
		assert.ok(!text.includes("sessions"));
	});

	it("uses plural for multiple sessions", () => {
		const text = unregisterConfirmText(2);
		assert.ok(text.includes("2"));
		assert.ok(text.includes("sessions"));
	});
});
