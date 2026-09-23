import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDefaultSessionNote, parseSessionNote, serializeSessionNote } from "../src/session-note.ts";
import {
	CLAUDE_ENGINE,
	CODEX_ENGINE,
	DEFAULT_ENGINE_ID,
	engineCreatesHookFile,
	engineSettingsPath,
	loadSlashCommandsFor,
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
	newSessionEngine,
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

	it("describes start, Stop, and Notification hooks the plugin registers", () => {
		const hooks = CLAUDE_ENGINE.hooks;
		assert.notEqual(hooks, null);
		assert.deepStrictEqual(hooks!.settingsSegments, [".claude", "settings.json"]);
		assert.deepStrictEqual(hooks!.entries, [
			{ role: "turn-start", event: "UserPromptSubmit", script: "co-prompt-submit-hook.sh" },
			{ role: "turn-end", event: "Stop", script: "co-stop-hook.sh" },
			{ role: "waiting-for-input", event: "Notification", script: "co-notification-hook.sh" },
		]);
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

describe("hook roles are engine-independent", () => {
	it("every hook-driven engine disarms Queue on UserPromptSubmit", () => {
		for (const id of availableEngineIds()) {
			const def = getEngineDefinition(id)!;
			if (def.completionSignal !== "hook") continue;
			const start = def.hooks?.entries.find((e) => e.role === "turn-start");
			assert.equal(start?.event, "UserPromptSubmit", `${id} reports turn start`);
		}
	});

	it("every registered engine that reports completion names a turn-end hook", () => {
		for (const id of availableEngineIds()) {
			const def = getEngineDefinition(id)!;
			if (def.completionSignal !== "hook") continue;
			const roles = (def.hooks?.entries ?? []).map((e) => e.role);
			assert.ok(roles.includes("turn-end"), `${id} names a turn-end hook`);
		}
	});

	it("no engine reuses one role twice", () => {
		for (const id of availableEngineIds()) {
			const roles = (getEngineDefinition(id)!.hooks?.entries ?? []).map((e) => e.role);
			assert.equal(new Set(roles).size, roles.length, `${id} has distinct roles`);
		}
	});
});

describe("engine registry integrity", () => {
	it("every registered definition is self-consistent", () => {
		for (const id of availableEngineIds()) {
			const def = getEngineDefinition(id) as EngineDefinition;
			assert.equal(def.id, id);
			assert.ok(def.label.length > 0, `${id} has a label`);
			assert.ok(def.binaryNames.length > 0, `${id} names at least one binary`);
			assert.ok(["hook", "none"].includes(def.completionSignal));
			assert.ok(def.binarySearchPaths.every((p) => p.length > 0), `${id} search paths are non-empty`);
		}
	});

	it("returns null for an id with no definition rather than throwing", () => {
		for (const id of ENGINE_IDS) {
			const def = getEngineDefinition(id);
			assert.ok(def === null || def.id === id);
		}
	});
});

// ---------------------------------------------------------------------------
// Codex definition — every value here traces to CodexProbe's measured
// evidence (codex-cli 0.154.0-alpha.6.2), not to guesswork.
// ---------------------------------------------------------------------------

describe("CODEX_ENGINE definition", () => {
	it("is registered, so notes naming codex resolve to a real definition", () => {
		assert.equal(getEngineDefinition("codex"), CODEX_ENGINE);
		assert.equal(CODEX_ENGINE.id, "codex");
		assert.equal(resolveEngineRef("codex").status, "known");
	});

	it("reports a hook-based completion signal — Codex has structured hooks", () => {
		assert.equal(CODEX_ENGINE.completionSignal, "hook");
		assert.equal(engineSupportsAutoSend(resolveEngineRef("codex")), true);
	});

	it("maps the waiting-for-input role onto PermissionRequest, not Notification", () => {
		// Codex has no Notification event; PermissionRequest is the equivalent.
		const entries = CODEX_ENGINE.hooks?.entries ?? [];
		const waiting = entries.find((e) => e.role === "waiting-for-input");
		assert.equal(waiting?.event, "PermissionRequest");
		assert.ok(!entries.some((e) => e.event === "Notification"));
	});

	it("registers Stop for turn-end and Interrupt for an aborted turn", () => {
		const byRole = new Map((CODEX_ENGINE.hooks?.entries ?? []).map((e) => [e.role, e.event]));
		assert.equal(byRole.get("turn-end"), "Stop");
		assert.equal(byRole.get("interrupted"), "Interrupt");
	});

	it("writes hooks to ~/.codex/hooks.json, not Claude's settings.json", () => {
		assert.deepStrictEqual(CODEX_ENGINE.hooks?.settingsSegments, [".codex", "hooks.json"]);
		assert.equal(engineSettingsPath(resolveEngineRef("codex"), "/Users/tester"), "/Users/tester/.codex/hooks.json");
	});

	it("uses Codex-specific hook scripts — its payload shape differs from Claude's", () => {
		const scripts = (CODEX_ENGINE.hooks?.entries ?? []).map((e) => e.script);
		for (const s of scripts) {
			assert.ok(s.startsWith("co-codex-"), `${s} is Codex-specific`);
		}
	});

	it("claims no slash commands — none are verified for the Codex TUI", () => {
		assert.deepStrictEqual([...CODEX_ENGINE.builtinSlashCommands], []);
		assert.deepStrictEqual(engineSkillDirs(resolveEngineRef("codex"), ["/Users/tester"]), []);
		assert.deepStrictEqual(loadSlashCommandsFor(resolveEngineRef("codex"), ["/Users/tester"]), []);
	});
});

describe("resolveEngineBinary for Codex", () => {
	const home = "/Users/tester";
	const APP = "/Applications/ChatGPT.app/Contents/Resources/codex";

	it("prefers a real PATH-style install over the ChatGPT.app bundle", () => {
		const found = resolveEngineBinary(CODEX_ENGINE, home, (p) => p === "/opt/homebrew/bin/codex" || p === APP);
		assert.equal(found, "/opt/homebrew/bin/codex");
	});

	it("falls back to the ChatGPT.app bundle when nothing else is installed", () => {
		assert.equal(resolveEngineBinary(CODEX_ENGINE, home, (p) => p === APP), APP);
	});

	it("falls back to the bare name when the app bundle has moved", () => {
		assert.equal(resolveEngineBinary(CODEX_ENGINE, home, () => false), "codex");
	});
});

describe("engineCreatesHookFile", () => {
	it("creates Codex's dedicated hooks.json when absent", () => {
		assert.equal(engineCreatesHookFile(resolveEngineRef("codex")), true);
	});

	it("never conjures Claude's shared settings.json", () => {
		assert.equal(engineCreatesHookFile(resolveEngineRef("claude")), false);
	});

	it("is false for an unavailable engine", () => {
		assert.equal(engineCreatesHookFile(resolveEngineRef("gpt-5-turbo")), false);
	});
});

// ---------------------------------------------------------------------------
// Engine selection: the note decides for existing sessions; defaults only
// seed new ones.
// ---------------------------------------------------------------------------

describe("new-session engine choice", () => {
	it("uses the project default", () => {
		assert.equal(newSessionEngine("codex", "claude"), "codex");
	});

	it("falls back to the global default when the project says nothing", () => {
		assert.equal(newSessionEngine(null, "codex"), "codex");
	});

	it("falls back to Claude when nothing is configured", () => {
		assert.equal(newSessionEngine(null, null), "claude");
	});

	it("ignores an unrecognized default rather than failing the create", () => {
		assert.equal(newSessionEngine("nonsense", null), "claude");
	});

	it("ignores an engine id that has no definition", () => {
		assert.equal(newSessionEngine("  ", "   "), "claude");
	});
});

describe("defaults never reach an existing session", () => {
	// Regression. resolveSessionEngineRef() fell through note -> project
	// default -> global default, so flipping the default to Codex silently
	// relabelled every legacy Claude card, while the queue kept driving them
	// as Claude via resolveEngineRef(""). Cards and queue disagreed.
	it("a note with no engine is Claude, whatever the defaults say", () => {
		assert.equal(resolveEngineRef("").id, "claude");
		assert.equal(resolveEngineRef(null).id, "claude");
		assert.equal(resolveEngineRef(undefined).id, "claude");
	});

	it("does not export a defaults-aware resolver for existing notes", async () => {
		const mod: Record<string, unknown> = await import("../src/engines.ts");
		assert.equal(
			"resolveSessionEngineRef" in mod, false,
			"an existing session's engine must come from its note alone; defaults are for new sessions only",
		);
	});

	it("does not export engine switching or queue transfer", async () => {
		const mod: Record<string, unknown> = await import("../src/engines.ts");
		for (const gone of ["planEngineSwitch", "transferQueue"]) {
			assert.equal(gone in mod, false, `${gone} was removed: sessions do not change engine`);
		}
	});
});

describe("creating one session per engine", () => {
	// The point of the feature after the trim: run Claude in one session and
	// Codex in another, side by side. Both must carry their engine on their
	// own note from the moment they exist.
	it("stamps each new session with the engine it was created for", () => {
		for (const id of availableEngineIds()) {
			const note = parseSessionNote(createDefaultSessionNote(`P-${id}`, "manual", id));
			assert.equal(note.engine, id, `${id} session records its engine`);
			assert.equal(resolveEngineRef(note.engine).id, id);
		}
	});

	it("keeps two coexisting sessions on their own engines", () => {
		const claude = parseSessionNote(createDefaultSessionNote("P-1", "manual", newSessionEngine("claude", null)));
		const codex = parseSessionNote(createDefaultSessionNote("P-2", "manual", newSessionEngine("codex", null)));
		assert.equal(resolveEngineRef(claude.engine).id, "claude");
		assert.equal(resolveEngineRef(codex.engine).id, "codex");
		assert.notEqual(resolveEngineRef(claude.engine).id, resolveEngineRef(codex.engine).id);
	});

	it("a later change of default leaves both notes alone", () => {
		const codexNote = parseSessionNote(createDefaultSessionNote("P-2", "manual", "codex"));
		const legacy = parseSessionNote(createDefaultSessionNote("P-3", "manual"));
		// Default flips to Codex afterwards.
		assert.equal(newSessionEngine("codex", "codex"), "codex");
		assert.equal(resolveEngineRef(codexNote.engine).id, "codex", "explicit note is untouched");
		assert.equal(resolveEngineRef(legacy.engine).id, "claude", "legacy note stays Claude");
	});

	it("round-trips an engine through serialize/parse without drift", () => {
		for (const id of availableEngineIds()) {
			const once = createDefaultSessionNote("P-1", "manual", id);
			const twice = serializeSessionNote(parseSessionNote(once));
			assert.equal(parseSessionNote(twice).engine, id);
		}
	});
});
