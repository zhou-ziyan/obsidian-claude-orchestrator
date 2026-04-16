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
} from "../src/utils.ts";

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
			),
			"15_Claude_Orchestrator",
		);
	});

	it("extracts project from nested note path", () => {
		assert.equal(
			resolveProjectFromPath(
				"01_Projects/15_Claude_Orchestrator/sessions/session-2.md",
			),
			"15_Claude_Orchestrator",
		);
	});

	it("returns null for non-project paths", () => {
		assert.equal(resolveProjectFromPath("02_Areas/someNote.md"), null);
	});

	it("returns null for root-level files", () => {
		assert.equal(resolveProjectFromPath("README.md"), null);
	});

	it("returns null for path that mentions 01_Projects but no subfolder", () => {
		assert.equal(resolveProjectFromPath("01_Projects/"), null);
	});

	it("handles different project names", () => {
		assert.equal(
			resolveProjectFromPath(
				"01_Projects/14_Mobile_Claude_Code/notes.md",
			),
			"14_Mobile_Claude_Code",
		);
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

describe("sessionNotePath", () => {
	it("returns correct vault-relative path", () => {
		assert.equal(
			sessionNotePath("15_Claude_Orchestrator", "15_Claude_Orchestrator"),
			"01_Projects/15_Claude_Orchestrator/sessions/15_Claude_Orchestrator.md",
		);
	});

	it("handles numbered session names", () => {
		assert.equal(
			sessionNotePath("15_Claude_Orchestrator", "15_Claude_Orchestrator-2"),
			"01_Projects/15_Claude_Orchestrator/sessions/15_Claude_Orchestrator-2.md",
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
