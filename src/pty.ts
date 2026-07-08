/**
 * PTY budget monitoring: macOS caps pseudo-terminals at kern.tty.ptmx_max;
 * every terminal panel consumes one. Display levels feed the session
 * manager footer, status gating blocks spawns at the hard limit.
 */

// Display levels (session manager footer bar).
export const PTY_THRESHOLD_WARNING = 0.7;

export const PTY_THRESHOLD_CRITICAL = 0.9;
// Pre-spawn gating (warn just below the hard limit, block at it).

// Pre-spawn gating (warn just below the hard limit, block at it).
export const PTY_WARNING_THRESHOLD = 0.9;

export const PTY_DEFAULT_MAX = 511;

export interface PtyUsage {
	used: number;
	max: number;
}

export type PtyLevel = "ok" | "warning" | "critical";

export type PtyStatus = "ok" | "warning" | "exhausted";

export function parsePtyMax(sysctlOutput: string): number {
	const n = parseInt(sysctlOutput.trim(), 10);
	return isNaN(n) ? 0 : n;
}

export function ptyMaxWithDefault(parsedMax: number): number {
	return parsedMax > 0 ? parsedMax : PTY_DEFAULT_MAX;
}

export function countPtyEntries(devEntries: string[]): number {
	return devEntries.filter((name) => name.startsWith("ttys")).length;
}

export function ptyLevel(used: number, max: number): PtyLevel {
	if (max <= 0) return "ok";
	const ratio = used / max;
	if (ratio >= PTY_THRESHOLD_CRITICAL) return "critical";
	if (ratio >= PTY_THRESHOLD_WARNING) return "warning";
	return "ok";
}

export function getPtyStatus(usage: PtyUsage): PtyStatus {
	if (usage.used >= usage.max) return "exhausted";
	if (usage.used > usage.max * PTY_WARNING_THRESHOLD) return "warning";
	return "ok";
}

export function ptyStatusMessage(usage: PtyUsage, status: PtyStatus): string {
	switch (status) {
		case "exhausted":
			return `PTY exhausted (${usage.used}/${usage.max}). Close unused terminals before creating new ones.`;
		case "warning":
			return `PTY usage high (${usage.used}/${usage.max}). Consider closing unused terminals.`;
		case "ok":
			return "";
	}
}

export function fetchPtyUsage(): Promise<PtyUsage> {
	const { execFile } = require("child_process") as typeof import("child_process");
	const { readdirSync } = require("fs") as typeof import("fs");

	return new Promise((resolve) => {
		execFile(
			"sysctl",
			["-n", "kern.tty.ptmx_max"],
			(err, stdout) => {
				const max = ptyMaxWithDefault(err ? 0 : parsePtyMax(stdout));
				try {
					resolve({ used: countPtyEntries(readdirSync("/dev")), max });
				} catch {
					resolve({ used: 0, max });
				}
			},
		);
	});
}

export function ptyBarPercent(used: number, max: number): number {
	if (max <= 0) return 0;
	return Math.min(100, Math.round((used / max) * 100));
}
