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
} from "../src/utils.ts";
import type { ProjectRegistry } from "../src/utils.ts";

const TEST_PROJECTS: ProjectRegistry = {
	"15_Claude_Orchestrator": { vaultFolder: "01_Projects/15_Claude_Orchestrator" },
	"14_Mobile_Claude_Code": { vaultFolder: "01_Projects/14_Mobile_Claude_Code" },
};

// --- generateSessionName ---

describe("generateSessionName", () => {
	it("returns base name when nothing exists", () => {
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", new Set()),
			"15_Claude_Orchestrator",
		);
	});

	it("returns base name when other projects exist but not this one", () => {
		const existing = new Set(["14_Mobile_Claude_Code"]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator",
		);
	});

	it("returns -2 when base name is taken", () => {
		const existing = new Set(["15_Claude_Orchestrator"]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-2",
		);
	});

	it("returns -3 when base and -2 are taken", () => {
		const existing = new Set([
			"15_Claude_Orchestrator",
			"15_Claude_Orchestrator-2",
		]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-3",
		);
	});

	it("fills gaps (base + -3 taken, returns -2)", () => {
		const existing = new Set([
			"15_Claude_Orchestrator",
			"15_Claude_Orchestrator-3",
		]);
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-2",
		);
	});

	it("handles many existing sessions", () => {
		const existing = new Set<string>();
		for (let i = 0; i <= 10; i++) {
			existing.add(
				i === 0
					? "15_Claude_Orchestrator"
					: `15_Claude_Orchestrator-${i + 1}`,
			);
		}
		// 2 through 11 are taken, next is 12
		assert.equal(
			generateSessionName("15_Claude_Orchestrator", existing),
			"15_Claude_Orchestrator-12",
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
			pinnedNote: "01_Projects/15_Claude_Orchestrator/15_Claude_Orchestrator.md",
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
			pinnedNote: null,
			history: [],
			queue: [],
		};
		const md = serializeSessionNote(note);
		const parsed = parseSessionNote(md);
		assert.deepEqual(parsed, note);
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
				["15_Claude_Orchestrator", { pinnedNote: "note.md", queueCount: 2, lastActivity: "2026-04-15 14:30" }],
				["14_Mobile_Claude_Code", { pinnedNote: null, queueCount: 0, lastActivity: null }],
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
				["15_Claude_Orchestrator", { pinnedNote: "a.md", queueCount: 3, lastActivity: "2026-04-15 10:00" }],
			]),
			TEST_PROJECTS,
		);
		const orch = groups.find((g) => g.project === "15_Claude_Orchestrator")!;
		assert.equal(orch.sessions[0].hasNote, true);
		assert.equal(orch.sessions[0].pinnedNote, "a.md");
		assert.equal(orch.sessions[0].queueCount, 3);
		assert.equal(orch.sessions[1].hasNote, false);
		assert.equal(orch.sessions[1].queueCount, 0);
	});

	it("returns empty array for no sessions", () => {
		const groups = groupSessionsByProject([], new Set(), new Map(), TEST_PROJECTS);
		assert.deepEqual(groups, []);
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
			pinnedNote: null,
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
			pinnedNote: null,
			history: [],
			queue: ["[2026-04-16 23:12] Line one\n\n## Section\nContent"],
		};
		const md = serializeSessionNote(original);
		const parsed = parseSessionNote(md);
		assert.equal(parsed.queue.length, 1);
		assert.ok(parsed.queue[0]!.includes("## Section"));
		assert.ok(parsed.queue[0]!.includes("Content"));
	});

	it("parses pinnedNote from frontmatter", () => {
		const md = [
			"---",
			"session: test",
			"status: running",
			"pinnedNote: 01_Projects/15_Claude/notes.md",
			"---",
			"",
			"## History",
			"## Queue",
		].join("\n");
		const note = parseSessionNote(md);
		assert.equal(note.pinnedNote, "01_Projects/15_Claude/notes.md");
		assert.equal(note.status, "running");
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

	it("returns project name for single session", () => {
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
