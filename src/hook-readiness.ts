import { createHash } from "crypto";
import { shellQuoteSingle } from "./stop-signal.ts";
import type { EngineHookRole } from "./engines.ts";

export type HookReadinessState = "ready" | "reload-required" | "repair-required";

export type HookReadinessIssueCode =
	| "runtime-generation-mismatch"
	| "bundle-unreadable"
	| "settings-unreadable"
	| "hook-missing"
	| "hook-path-mismatch"
	| "script-missing"
	| "script-content-mismatch"
	| "script-not-executable";

export interface HookReadinessIssue {
	code: HookReadinessIssueCode;
	event?: string;
	scriptName?: string;
}

export interface HookRegistrationReadinessInput {
	role: EngineHookRole;
	event: string;
	scriptName: string;
	expectedPath: string;
	expectedSource: string;
	actualSource: string | null;
	executable: boolean;
}

export interface ProviderHookReadinessInput {
	provider: string;
	settingsJson: string | null;
	registrations: HookRegistrationReadinessInput[];
}

export interface HookReadinessInput {
	checkedAt: number;
	/** Fingerprint captured from main.js when this plugin instance loaded. */
	loadedRuntimeGeneration: string;
	/** Current main.js fingerprint. A different value means reload is needed. */
	diskBundleGeneration: string | null;
	providers: ProviderHookReadinessInput[];
}

export interface ProviderHookReadiness {
	provider: string;
	ready: boolean;
	state: HookReadinessState;
	reason: string | null;
	issues: HookReadinessIssue[];
}

export interface HookReadinessSnapshot {
	state: HookReadinessState;
	checkedAt: number;
	loadedRuntimeGeneration: string;
	diskBundleGeneration: string | null;
	providers: Record<string, ProviderHookReadiness>;
}

interface HookEntry {
	command?: unknown;
}

interface HookMatcher {
	hooks?: HookEntry[];
}

/** Stable, content-based identity for the exact bundle a runtime loaded. */
export function bundleGeneration(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function parseHooks(settingsJson: string | null): Record<string, HookMatcher[]> | null {
	if (settingsJson === null) return null;
	try {
		const parsed = JSON.parse(settingsJson) as { hooks?: unknown };
		if (!parsed.hooks || typeof parsed.hooks !== "object") return {};
		return parsed.hooks as Record<string, HookMatcher[]>;
	} catch {
		return null;
	}
}

function issueReason(state: HookReadinessState, issues: HookReadinessIssue[]): string | null {
	if (state === "ready") return null;
	if (state === "reload-required") return "Reload required: the running plugin does not match the bundle on disk";
	const first = issues[0];
	if (!first) return "Hook repair required";
	const target = first.event ?? first.scriptName ?? "hook runtime";
	return `Hook repair required: ${target} (${first.code})`;
}

/**
 * Evaluate only bounded metadata. The result intentionally contains no raw
 * settings JSON, hook stdout, prompts, transcript paths, tokens or command
 * output; it is safe to surface in the Session Manager.
 */
export function inspectHookReadiness(input: HookReadinessInput): HookReadinessSnapshot {
	const generationIssue: HookReadinessIssue | null = input.diskBundleGeneration === null
		? { code: "bundle-unreadable" }
		: input.diskBundleGeneration !== input.loadedRuntimeGeneration
			? { code: "runtime-generation-mismatch" }
			: null;
	const providers: Record<string, ProviderHookReadiness> = {};

	for (const providerInput of input.providers) {
		const issues: HookReadinessIssue[] = [];
		if (generationIssue) issues.push(generationIssue);
		const hooks = parseHooks(providerInput.settingsJson);
		if (hooks === null) issues.push({ code: "settings-unreadable" });

		for (const registration of providerInput.registrations) {
			if (registration.actualSource === null) {
				issues.push({ code: "script-missing", scriptName: registration.scriptName });
			} else if (registration.actualSource !== registration.expectedSource) {
				issues.push({ code: "script-content-mismatch", scriptName: registration.scriptName });
			}
			if (!registration.executable) {
				issues.push({ code: "script-not-executable", scriptName: registration.scriptName });
			}

			if (hooks !== null) {
				const entries = Array.isArray(hooks[registration.event])
					? hooks[registration.event]!.flatMap((matcher) => Array.isArray(matcher.hooks) ? matcher.hooks : [])
					: [];
				const pluginEntry = entries.find((entry) => typeof entry.command === "string"
					&& entry.command.includes(registration.scriptName));
				if (!pluginEntry) {
					issues.push({ code: "hook-missing", event: registration.event, scriptName: registration.scriptName });
				} else if (pluginEntry.command !== shellQuoteSingle(registration.expectedPath)) {
					issues.push({ code: "hook-path-mismatch", event: registration.event, scriptName: registration.scriptName });
				}
			}
		}

		const state: HookReadinessState = generationIssue?.code === "runtime-generation-mismatch"
			? "reload-required"
			: issues.length > 0 ? "repair-required" : "ready";
		providers[providerInput.provider] = {
			provider: providerInput.provider,
			ready: state === "ready",
			state,
			reason: issueReason(state, issues),
			issues,
		};
	}

	const providerStates = Object.values(providers).map((provider) => provider.state);
	const state: HookReadinessState = generationIssue?.code === "runtime-generation-mismatch"
		? "reload-required"
		: providerStates.some((providerState) => providerState !== "ready")
			? "repair-required"
			: "ready";
	return {
		state,
		checkedAt: input.checkedAt,
		loadedRuntimeGeneration: input.loadedRuntimeGeneration,
		diskBundleGeneration: input.diskBundleGeneration,
		providers,
	};
}
