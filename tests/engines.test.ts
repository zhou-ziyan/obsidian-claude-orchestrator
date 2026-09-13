import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CLAUDE_ENGINE,
	DEFAULT_ENGINE_ID,
	ENGINE_IDS,
	availableEngineIds,
	effectiveQueueMode,
	engineDisplayLabel,
	engineQueueModes,
	engineSkillDirs,
	engineSupportsAutoSend,
	getEngineDefinition,
	isEngineId,
	resolveEngineBinary,
	resolveEngineRef,
} from "../src/engines.ts";
import type { EngineDefinition } from "../src/engines.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/slash-commands.ts";

// ---------------------------------------------------------------------------
// Engine id vocabulary
// ---------------------------------------------------------------------------

describe("engine ids", () => {
	it("covers the two engines the product targets", () => {
		assert.deepStrictEqual([...ENGINE_IDS], ["claude", "codex"]);
	});

	it("defaults to claude — old sessions predate the engine field", () => {
		assert.equal(DEFAULT_ENGINE_ID, "claude");
	});

	it("recognizes only known ids", () => {
		assert.equal(isEngineId("claude"), true);
		assert.equal(isEngineId("codex"), true);
		assert.equal(isEngineId("gemini"), false);
		assert.equal(isEngineId(""), false);
		assert.equal(isEngineId(undefined), false);
		assert.equal(isEngineId(42), false);
	});

	it("only reports engines that actually have a definition as available", () => {
		const available = availableEngineIds();
		assert.ok(available.includes("claude"));
		for (const id of available) {
			assert.notEqual(getEngineDefinition(id), null);
		}
	});
});

// ---------------------------------------------------------------------------
// Resolution — the "unknown provider fails safe" contract
// ---------------------------------------------------------------------------

describe("resolveEngineRef", () => {
	it("treats a missing engine field as Claude (legacy note migration)", () => {
		for (const raw of [undefined, null, "", "   "]) {
			const ref = resolveEngineRef(raw);
			assert.equal(ref.status, "default", `raw=${JSON.stringify(raw)}`);
			assert.equal(ref.id, "claude");
			assert.equal(ref.raw, null);
			assert.equal(ref.definition, CLAUDE_ENGINE);
		}
	});

	it("resolves an explicit claude engine", () => {
		const ref = resolveEngineRef("claude");
		assert.equal(ref.status, "known");
		assert.equal(ref.id, "claude");
		assert.equal(ref.raw, "claude");
		assert.equal(ref.definition, CLAUDE_ENGINE);
	});

	it("normalizes case and surrounding whitespace", () => {
		const ref = resolveEngineRef("  Claude \n");
		assert.equal(ref.status, "known");
		assert.equal(ref.id, "claude");
	});

	it("keeps the raw value for a recognized-but-unimplemented engine", () => {
		// Codex is a known product id; its definition lands with CodexAdapter.
		// Until then it must resolve to no definition rather than to Claude.
		const ref = resolveEngineRef("codex");
		assert.equal(ref.id, "codex");
		assert.equal(ref.raw, "codex");
		if (getEngineDefinition("codex") === null) {
			assert.equal(ref.status, "unavailable");
			assert.equal(ref.definition, null);
		} else {
			assert.equal(ref.status, "known");
		}
	});

	it("never silently falls back to Claude for an unrecognized engine", () => {
		const ref = resolveEngineRef("gpt-5-turbo");
		assert.equal(ref.status, "unavailable");
		assert.equal(ref.id, null);
		assert.equal(ref.definition, null);
		assert.equal(ref.raw, "gpt-5-turbo", "raw value is kept for display and fidelity");
	});
});

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

describe("engine queue-mode capability", () => {
	it("allows every queue mode for an engine with a completion hook", () => {
		const ref = resolveEngineRef("claude");
		assert.deepStrictEqual(engineQueueModes(ref), ["manual", "listen", "auto"]);
		assert.equal(engineSupportsAutoSend(ref), true);
	});

	it("allows every queue mode for a legacy note with no engine field", () => {
		assert.deepStrictEqual(engineQueueModes(resolveEngineRef(undefined)), ["manual", "listen", "auto"]);
	});

	it("offers manual only when the engine is unavailable", () => {
		const ref = resolveEngineRef("gpt-5-turbo");
		assert.deepStrictEqual(engineQueueModes(ref), ["manual"]);
		assert.equal(engineSupportsAutoSend(ref), false);
	});

	it("clamps an unsupported stored mode down to manual", () => {
		const unavailable = resolveEngineRef("gpt-5-turbo");
		assert.equal(effectiveQueueMode(unavailable, "auto"), "manual");
		assert.equal(effectiveQueueMode(unavailable, "listen"), "manual");
		assert.equal(effectiveQueueMode(unavailable, "manual"), "manual");
	});

	it("leaves supported modes untouched", () => {
		const claude = resolveEngineRef("claude");
		assert.equal(effectiveQueueMode(claude, "auto"), "auto");
		assert.equal(effectiveQueueMode(claude, "listen"), "listen");
		assert.equal(effectiveQueueMode(claude, "manual"), "manual");
	});
});

describe("engineDisplayLabel", () => {
	it("labels a known engine", () => {
		assert.equal(engineDisplayLabel(resolveEngineRef("claude")), CLAUDE_ENGINE.label);
	});

	it("labels a legacy note with the default engine", () => {
		assert.equal(engineDisplayLabel(resolveEngineRef(null)), CLAUDE_ENGINE.label);
	});

	it("shows the raw value for an unavailable engine instead of pretending", () => {
		const label = engineDisplayLabel(resolveEngineRef("gpt-5-turbo"));
		assert.ok(label.includes("gpt-5-turbo"), `label was ${label}`);
	});
});

// ---------------------------------------------------------------------------
// Claude definition — parity with today's hard-coded behavior
// ---------------------------------------------------------------------------

describe("CLAUDE_ENGINE definition", () => {
	it("is registered under its own id", () => {
		assert.equal(getEngineDefinition("claude"), CLAUDE_ENGINE);
		assert.equal(CLAUDE_ENGINE.id, "claude");
	});

	it("reports a hook-based completion signal", () => {
		assert.equal(CLAUDE_ENGINE.completionSignal, "hook");
	});

	it("carries the Claude Code builtin slash commands", () => {
		assert.deepStrictEqual(
			[...CLAUDE_ENGINE.builtinSlashCommands],
			[...BUILTIN_SLASH_COMMANDS],
		);
	});

	it("describes the Stop and Notification hooks the plugin registers", () => {
		const hooks = CLAUDE_ENGINE.hooks;
		assert.notEqual(hooks, null);
		assert.deepStrictEqual(hooks!.settingsSegments, [".claude", "settings.json"]);
		assert.deepStrictEqual(hooks!.entries, [
			{ event: "Stop", script: "co-stop-hook.sh" },
			{ event: "Notification", script: "co-notification-hook.sh" },
		]);
	});
});

describe("Claude launch and resume commands", () => {
	it("launches bare interactive claude by default", () => {
		assert.deepStrictEqual(CLAUDE_ENGINE.buildLaunchCommand(), { command: "claude", args: [] });
	});

	it("passes an explicit model through --model", () => {
		assert.deepStrictEqual(
			CLAUDE_ENGINE.buildLaunchCommand({ model: "opus" }),
			{ command: "claude", args: ["--model", "opus"] },
		);
	});

	it("ignores a blank model rather than emitting an empty flag", () => {
		assert.deepStrictEqual(CLAUDE_ENGINE.buildLaunchCommand({ model: "  " }), { command: "claude", args: [] });
	});

	it("resumes the most recent conversation with --continue when no id is known", () => {
		assert.deepStrictEqual(
			CLAUDE_ENGINE.buildResumeCommand(),
			{ command: "claude", args: ["--continue"] },
		);
	});

	it("resumes a specific conversation with --resume <id>", () => {
		assert.deepStrictEqual(
			CLAUDE_ENGINE.buildResumeCommand({ conversationId: "abc-123" }),
			{ command: "claude", args: ["--resume", "abc-123"] },
		);
	});

	it("combines resume with a model override", () => {
		assert.deepStrictEqual(
			CLAUDE_ENGINE.buildResumeCommand({ conversationId: "abc-123", model: "sonnet" }),
			{ command: "claude", args: ["--resume", "abc-123", "--model", "sonnet"] },
		);
	});
});

describe("resolveEngineBinary", () => {
	const home = "/Users/tester";

	it("prefers the first search path that exists", () => {
		const seen: string[] = [];
		const found = resolveEngineBinary(CLAUDE_ENGINE, home, (p) => {
			seen.push(p);
			return p === `${home}/.local/bin/claude`;
		});
		assert.equal(found, `${home}/.local/bin/claude`);
		assert.ok(seen.length > 0);
	});

	it("falls back to the bare binary name so PATH lookup still applies", () => {
		assert.equal(resolveEngineBinary(CLAUDE_ENGINE, home, () => false), "claude");
	});

	it("expands ~ against the supplied home directory", () => {
		const probed: string[] = [];
		resolveEngineBinary(CLAUDE_ENGINE, home, (p) => { probed.push(p); return false; });
		for (const p of probed) {
			assert.ok(!p.startsWith("~"), `unexpanded path: ${p}`);
		}
	});
});

describe("engineSkillDirs", () => {
	it("returns Claude's skill directories for every root", () => {
		const dirs = engineSkillDirs(resolveEngineRef("claude"), ["/Users/tester", "/vault", "/code/app"]);
		assert.deepStrictEqual(dirs, [
			"/Users/tester/.claude/skills",
			"/vault/.claude/skills",
			"/code/app/.claude/skills",
		]);
	});

	it("returns the same directories for a legacy note with no engine", () => {
		assert.deepStrictEqual(
			engineSkillDirs(resolveEngineRef(undefined), ["/Users/tester"]),
			["/Users/tester/.claude/skills"],
		);
	});

	it("returns nothing for an unavailable engine", () => {
		assert.deepStrictEqual(engineSkillDirs(resolveEngineRef("gpt-5-turbo"), ["/Users/tester"]), []);
	});

	it("skips empty roots", () => {
		assert.deepStrictEqual(engineSkillDirs(resolveEngineRef("claude"), ["", "/vault"]), ["/vault/.claude/skills"]);
	});
});

// ---------------------------------------------------------------------------
// Registry shape — guards against a half-registered engine
// ---------------------------------------------------------------------------

describe("engine registry integrity", () => {
	it("every registered definition is self-consistent", () => {
		for (const id of availableEngineIds()) {
			const def = getEngineDefinition(id) as EngineDefinition;
			assert.equal(def.id, id);
			assert.ok(def.label.length > 0, `${id} has a label`);
			assert.ok(def.binaryNames.length > 0, `${id} names at least one binary`);
			assert.ok(["hook", "none"].includes(def.completionSignal));
			const launch = def.buildLaunchCommand();
			assert.ok(launch.command.length > 0);
			assert.ok(Array.isArray(launch.args));
		}
	});

	it("returns null for an id with no definition rather than throwing", () => {
		for (const id of ENGINE_IDS) {
			const def = getEngineDefinition(id);
			assert.ok(def === null || def.id === id);
		}
	});
});
