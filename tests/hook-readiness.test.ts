import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	bundleGeneration,
	inspectHookReadiness,
	type HookReadinessInput,
} from "../src/hook-readiness.ts";

const SCRIPT_DIR = "/Users/test/.claude-orchestrator/scripts";

function input(over: Partial<HookReadinessInput> = {}): HookReadinessInput {
	const loaded = bundleGeneration("bundle A");
	return {
		checkedAt: 1_000,
		loadedRuntimeGeneration: loaded,
		diskBundleGeneration: loaded,
		providers: [{
			provider: "claude",
			settingsJson: JSON.stringify({
				hooks: {
					UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: `'${SCRIPT_DIR}/co-prompt-submit-hook.sh'` }] }],
					Stop: [{ matcher: "*", hooks: [{ type: "command", command: `'${SCRIPT_DIR}/co-stop-hook.sh'` }] }],
				},
			}),
			registrations: [
				{ role: "turn-start", event: "UserPromptSubmit", scriptName: "co-prompt-submit-hook.sh", expectedPath: `${SCRIPT_DIR}/co-prompt-submit-hook.sh`, expectedSource: "start", actualSource: "start", executable: true },
				{ role: "turn-end", event: "Stop", scriptName: "co-stop-hook.sh", expectedPath: `${SCRIPT_DIR}/co-stop-hook.sh`, expectedSource: "stop", actualSource: "stop", executable: true },
			],
		}],
		...over,
	};
}

describe("runtime hook readiness", () => {
	it("is ready only when runtime, disk bundle, config, scripts, paths and permissions all agree", () => {
		const result = inspectHookReadiness(input());
		assert.equal(result.state, "ready");
		assert.equal(result.providers.claude?.ready, true);
		assert.deepStrictEqual(result.providers.claude?.issues, []);
	});

	it("detects an Obsidian runtime older than the bundle and requires reload", () => {
		const result = inspectHookReadiness(input({
			diskBundleGeneration: bundleGeneration("bundle B"),
		}));
		assert.equal(result.state, "reload-required");
		assert.equal(result.providers.claude?.ready, false);
		assert.ok(result.providers.claude?.issues.some((issue) => issue.code === "runtime-generation-mismatch"));
	});

	it("becomes ready after reload captures the new bundle generation", () => {
		const current = bundleGeneration("bundle B");
		const result = inspectHookReadiness(input({
			loadedRuntimeGeneration: current,
			diskBundleGeneration: current,
		}));
		assert.equal(result.state, "ready");
	});

	it("fails closed when either required start or stop hook is absent", () => {
		const base = input();
		const provider = base.providers[0]!;
		const settings = JSON.parse(provider.settingsJson!) as { hooks: Record<string, unknown> };
		delete settings.hooks.UserPromptSubmit;
		delete settings.hooks.Stop;
		const result = inspectHookReadiness(input({ providers: [{ ...provider, settingsJson: JSON.stringify(settings) }] }));
		assert.equal(result.state, "repair-required");
		assert.deepStrictEqual(
			result.providers.claude?.issues.filter((issue) => issue.code === "hook-missing").map((issue) => issue.event).sort(),
			["Stop", "UserPromptSubmit"],
		);
	});

	it("diagnoses a stale path, stale script body and non-executable script without exposing settings content", () => {
		const base = input();
		const provider = base.providers[0]!;
		const registrations = provider.registrations.map((registration, index) => index === 0
			? { ...registration, actualSource: "old", executable: false }
			: registration);
		const settings = provider.settingsJson!.replace(SCRIPT_DIR, "/old/plugin/scripts");
		const result = inspectHookReadiness(input({ providers: [{ ...provider, settingsJson: settings, registrations }] }));
		const codes = result.providers.claude?.issues.map((issue) => issue.code) ?? [];
		assert.ok(codes.includes("hook-path-mismatch"));
		assert.ok(codes.includes("script-content-mismatch"));
		assert.ok(codes.includes("script-not-executable"));
		assert.doesNotMatch(JSON.stringify(result), /hooks"|matcher|old"/);
	});

	it("keeps provider failures isolated while the global gate remains fail-closed", () => {
		const base = input();
		const claude = base.providers[0]!;
		const codex = { ...claude, provider: "codex", settingsJson: null };
		const result = inspectHookReadiness(input({ providers: [claude, codex] }));
		assert.equal(result.providers.claude?.ready, true);
		assert.equal(result.providers.codex?.ready, false);
		assert.equal(result.state, "repair-required");
	});
});
