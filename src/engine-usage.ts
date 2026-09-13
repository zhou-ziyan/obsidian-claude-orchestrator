/**
 * Engine usage readings — how much of a plan's allowance is spent, where
 * the number came from, and when it was read.
 *
 * The whole point of showing usage is to help decide which engine to run
 * next, so a wrong number is worse than no number. Three rules follow:
 *
 * - Missing is never zero. An absent window renders as "—", not "0%".
 * - Stale is labelled stale, never presented as current.
 * - `null` means "could not tell" and is kept distinct from `false`.
 *
 * Claude Code exposes no usage or rate-limit source on its CLI (there is no
 * such command or subcommand), so its reading is honestly unavailable
 * rather than fabricated. Manual switching stays available either way.
 */
import { execFile } from "child_process";
import type { EngineId } from "./engines.ts";

export interface UsageWindow {
	usedPercent: number;
	windowMinutes: number;
	/** Unix seconds — not milliseconds. */
	resetsAt: number | null;
}

export interface UsageCredits {
	hasCredits: boolean;
	balance: string | null;
}

export type EngineUsage =
	| {
		state: "available";
		engine: EngineId;
		source: string;
		fetchedAt: number;
		planType: string | null;
		primary: UsageWindow | null;
		secondary: UsageWindow | null;
		credits: UsageCredits | null;
		/** null = the backend did not say. Not the same as false. */
		ordinaryUsageAllowed: boolean | null;
	}
	| {
		state: "unavailable";
		engine: EngineId;
		source: string | null;
		reason: string;
		fetchedAt: number;
	};

/** A reading older than this is shown as stale rather than as current. */
export const USAGE_STALE_MS = 5 * 60 * 1000;

export const CODEX_USAGE_SOURCE = "codex app-server · account/rateLimits/read";

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function parseWindow(raw: unknown): UsageWindow | null {
	const w = asRecord(raw);
	if (!w) return null;
	if (typeof w.usedPercent !== "number") return null;
	return {
		usedPercent: w.usedPercent,
		windowMinutes: typeof w.windowDurationMins === "number" ? w.windowDurationMins : 0,
		resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null,
	};
}

function parseCredits(raw: unknown): UsageCredits | null {
	const c = asRecord(raw);
	if (!c) return null;
	return {
		hasCredits: c.hasCredits === true,
		balance: typeof c.balance === "string" ? c.balance : null,
	};
}

/** Parse an `account/rateLimits/read` result into a usage reading. */
export function parseCodexRateLimits(raw: unknown, fetchedAt: number): EngineUsage {
	const root = asRecord(raw);
	const limits = root ? asRecord(root.rateLimits) : null;
	if (!limits) {
		return {
			state: "unavailable", engine: "codex", source: CODEX_USAGE_SOURCE,
			reason: "no rateLimits in the app-server response", fetchedAt,
		};
	}
	return {
		state: "available",
		engine: "codex",
		source: CODEX_USAGE_SOURCE,
		fetchedAt,
		planType: typeof limits.planType === "string" ? limits.planType : null,
		primary: parseWindow(limits.primary),
		secondary: parseWindow(limits.secondary),
		credits: parseCredits(limits.credits),
		ordinaryUsageAllowed: typeof root?.ordinaryUsageAllowed === "boolean"
			? root.ordinaryUsageAllowed
			: null,
	};
}

export function claudeUsageUnavailable(fetchedAt: number): EngineUsage {
	return {
		state: "unavailable",
		engine: "claude",
		source: null,
		reason: "the Claude Code CLI exposes no usage or rate-limit source",
		fetchedAt,
	};
}

export function formatUsagePercent(window: UsageWindow | null): string {
	if (!window) return "—";
	const clamped = Math.min(100, Math.max(0, window.usedPercent));
	return `${Math.round(clamped)}%`;
}

/** Countdown to a reset, from a Unix-seconds timestamp. */
export function formatResetsIn(resetsAt: number | null, nowMs: number): string {
	if (resetsAt === null) return "—";
	const remainingMs = resetsAt * 1000 - nowMs;
	if (remainingMs <= 0) return "now";
	const minutes = Math.round(remainingMs / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

export function usageIsStale(usage: EngineUsage | null, nowMs: number, ttlMs = USAGE_STALE_MS): boolean {
	if (!usage) return true;
	return nowMs - usage.fetchedAt > ttlMs;
}

export type UsageHeadroom = "ok" | "limited" | "exhausted" | "unknown";

/**
 * How much room is left. A full primary window does not by itself mean the
 * engine is unusable: measured during CodexProbe, requests still succeeded
 * at 100% with `ordinaryUsageAllowed: false` because credits covered them.
 */
export function usageHeadroom(usage: EngineUsage | null): UsageHeadroom {
	if (!usage || usage.state !== "available") return "unknown";
	const primary = usage.primary;
	if (!primary) return "unknown";
	if (primary.usedPercent < 100 && usage.ordinaryUsageAllowed !== false) return "ok";
	return usage.credits?.hasCredits ? "limited" : "exhausted";
}

export interface UsageDescription {
	value: string;
	source: string;
	stale: boolean;
	detail: string;
}

export function describeUsageSource(usage: EngineUsage | null, nowMs = Date.now()): UsageDescription {
	if (!usage) {
		return { value: "Unavailable", source: "no reading yet", stale: true, detail: "" };
	}
	if (usage.state === "unavailable") {
		return { value: "Unavailable", source: usage.source ?? usage.reason, stale: true, detail: usage.reason };
	}
	const detailParts: string[] = [];
	if (usage.planType) detailParts.push(usage.planType);
	if (usage.secondary) detailParts.push(`week ${formatUsagePercent(usage.secondary)}`);
	if (usage.primary?.resetsAt) detailParts.push(`resets ${formatResetsIn(usage.primary.resetsAt, nowMs)}`);
	if (usage.credits?.hasCredits && usage.credits.balance) detailParts.push(`credits ${usage.credits.balance}`);
	return {
		value: formatUsagePercent(usage.primary),
		source: usage.source,
		stale: usageIsStale(usage, nowMs),
		detail: detailParts.join(" · "),
	};
}

// --- app-server JSON-RPC (newline-delimited over stdio) ---

export interface AppServerMessage {
	jsonrpc: "2.0";
	id?: number;
	method: string;
	params: Record<string, unknown>;
}

export const RATE_LIMITS_REQUEST_ID = 2;

/** The exact handshake `account/rateLimits/read` needs. */
export function buildAppServerRequests(): AppServerMessage[] {
	return [
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-orchestrator", title: "Claude Orchestrator", version: "1" } } },
		{ jsonrpc: "2.0", method: "initialized", params: {} },
		{ jsonrpc: "2.0", id: RATE_LIMITS_REQUEST_ID, method: "account/rateLimits/read", params: {} },
	];
}

/** Pull the result for one request id out of the newline-delimited stream. */
export function parseAppServerLines(stdout: string, requestId: number): unknown {
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let msg: Record<string, unknown> | null;
		try {
			msg = asRecord(JSON.parse(trimmed));
		} catch {
			continue;
		}
		if (!msg || msg.id !== requestId) continue;
		if ("error" in msg) return null;
		if ("result" in msg) return msg.result;
	}
	return null;
}

/**
 * Read Codex's rate limits by speaking JSON-RPC to its own app-server on
 * stdio. Deliberately `--listen stdio://`: that spawns a private process,
 * while `app-server daemon` is shared machine-wide and would disturb a
 * Codex session the user is running.
 */
export function fetchCodexUsage(binary: string, timeoutMs = 15_000): Promise<EngineUsage> {
	return new Promise((resolve) => {
		const fail = (reason: string): void => resolve({
			state: "unavailable", engine: "codex", source: CODEX_USAGE_SOURCE,
			reason, fetchedAt: Date.now(),
		});
		let child;
		try {
			child = execFile(binary, ["app-server", "--listen", "stdio://"], { timeout: timeoutMs },
				(_err, stdout) => {
					const result = parseAppServerLines(stdout ?? "", RATE_LIMITS_REQUEST_ID);
					if (result === null) return fail("app-server returned no rate-limit result");
					resolve(parseCodexRateLimits(result, Date.now()));
				});
		} catch (err) {
			return fail(`could not start app-server: ${String(err)}`);
		}
		child.on("error", (err) => fail(`could not start app-server: ${err.message}`));
		const stdin = child.stdin;
		if (!stdin) return fail("app-server gave no stdin");
		for (const msg of buildAppServerRequests()) {
			stdin.write(`${JSON.stringify(msg)}\n`);
		}
		// The server keeps the stream open for notifications; close our side
		// so execFile's callback fires once it exits.
		setTimeout(() => { try { stdin.end(); child.kill(); } catch { /* already gone */ } }, timeoutMs - 1000);
	});
}
