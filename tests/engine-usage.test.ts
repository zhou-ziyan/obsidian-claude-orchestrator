import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildAppServerRequests,
	claudeUsageUnavailable,
	describeUsageSource,
	formatResetsIn,
	formatUsagePercent,
	parseAppServerLines,
	parseCodexRateLimits,
	usageHeadroom,
	usageIsStale,
	USAGE_STALE_MS,
} from "../src/engine-usage.ts";
import type { EngineUsage } from "../src/engine-usage.ts";

// Real (redacted) `account/rateLimits/read` response captured from
// codex-cli 0.154.0-alpha.6.2 during the CodexProbe task.
const CODEX_SAMPLE = {
	ordinaryUsageAllowed: false,
	rateLimits: {
		limitId: "codex",
		planType: "plus",
		primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1789305770 },
		secondary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 1789892570 },
		credits: { hasCredits: true, unlimited: false, balance: "76.1791000000" },
		spendControlReached: false,
		rateLimitReachedType: "rate_limit_reached",
	},
};

describe("parseCodexRateLimits", () => {
	it("reads both windows, plan and credits from a real response", () => {
		const usage = parseCodexRateLimits(CODEX_SAMPLE, 1_700_000_000_000);
		assert.equal(usage.state, "available");
		if (usage.state !== "available") return;
		assert.equal(usage.planType, "plus");
		assert.deepStrictEqual(usage.primary, { usedPercent: 100, windowMinutes: 300, resetsAt: 1789305770 });
		assert.deepStrictEqual(usage.secondary, { usedPercent: 16, windowMinutes: 10080, resetsAt: 1789892570 });
		assert.equal(usage.credits?.hasCredits, true);
		assert.equal(usage.credits?.balance, "76.1791000000");
		assert.equal(usage.ordinaryUsageAllowed, false);
		assert.equal(usage.fetchedAt, 1_700_000_000_000);
	});

	it("names its source so the UI can show where the number came from", () => {
		const usage = parseCodexRateLimits(CODEX_SAMPLE, 1);
		assert.match(usage.source ?? "", /account\/rateLimits\/read/);
	});

	it("keeps a missing ordinaryUsageAllowed as null, never false", () => {
		// null means "we could not tell"; false means "the backend said no".
		// Collapsing them would wrongly claim Codex is unusable.
		const usage = parseCodexRateLimits({ rateLimits: { primary: null } }, 1);
		assert.equal(usage.state, "available");
		if (usage.state !== "available") return;
		assert.equal(usage.ordinaryUsageAllowed, null);
	});

	it("keeps an absent window as null rather than inventing a zero", () => {
		const usage = parseCodexRateLimits({ rateLimits: { primary: null, secondary: null } }, 1);
		if (usage.state !== "available") return assert.fail("expected available");
		assert.equal(usage.primary, null);
		assert.equal(usage.secondary, null);
	});

	it("reports unavailable for a response with no rateLimits at all", () => {
		const usage = parseCodexRateLimits({}, 1);
		assert.equal(usage.state, "unavailable");
	});

	it("reports unavailable for junk instead of throwing", () => {
		for (const junk of [null, "nope", 42, []]) {
			assert.equal(parseCodexRateLimits(junk, 1).state, "unavailable");
		}
	});
});

describe("formatUsagePercent", () => {
	it("renders a real zero as 0%", () => {
		assert.equal(formatUsagePercent({ usedPercent: 0, windowMinutes: 300, resetsAt: null }), "0%");
	});

	it("renders a missing window as an em dash, never as 0%", () => {
		assert.equal(formatUsagePercent(null), "—");
	});

	it("rounds to whole percents", () => {
		assert.equal(formatUsagePercent({ usedPercent: 16.4, windowMinutes: 300, resetsAt: null }), "16%");
	});

	it("clamps a nonsense percent into range rather than displaying it raw", () => {
		assert.equal(formatUsagePercent({ usedPercent: 1000, windowMinutes: 1, resetsAt: null }), "100%");
		assert.equal(formatUsagePercent({ usedPercent: -5, windowMinutes: 1, resetsAt: null }), "0%");
	});
});

describe("formatResetsIn", () => {
	const now = 1_789_300_000_000; // ms

	it("formats a future reset as a countdown", () => {
		// resetsAt is Unix *seconds*, not milliseconds.
		assert.equal(formatResetsIn(1789303600, now), "1h");
	});

	it("formats sub-hour resets in minutes", () => {
		assert.equal(formatResetsIn(1789301800, now), "30m");
	});

	it("says nothing useful rather than a negative countdown", () => {
		assert.equal(formatResetsIn(1789200000, now), "now");
	});

	it("returns an em dash when there is no reset time", () => {
		assert.equal(formatResetsIn(null, now), "—");
	});
});

describe("usageIsStale", () => {
	const fresh: EngineUsage = {
		state: "available", engine: "codex", source: "x", fetchedAt: 1000,
		planType: null, primary: null, secondary: null, credits: null, ordinaryUsageAllowed: null,
	};

	it("is fresh right after fetching", () => {
		assert.equal(usageIsStale(fresh, 1000), false);
	});

	it("goes stale after the TTL", () => {
		assert.equal(usageIsStale(fresh, 1000 + USAGE_STALE_MS + 1), true);
	});

	it("treats a null reading as stale", () => {
		assert.equal(usageIsStale(null, 0), true);
	});
});

describe("usageHeadroom", () => {
	const base = { state: "available" as const, engine: "codex" as const, source: "x", fetchedAt: 0, planType: null, secondary: null };

	it("is unknown when there is no reading", () => {
		assert.equal(usageHeadroom(null), "unknown");
	});

	it("is unknown for an unavailable reading", () => {
		assert.equal(usageHeadroom(claudeUsageUnavailable(0)), "unknown");
	});

	it("is ok with plenty left", () => {
		assert.equal(usageHeadroom({
			...base, primary: { usedPercent: 20, windowMinutes: 300, resetsAt: null },
			credits: null, ordinaryUsageAllowed: true,
		}), "ok");
	});

	it("is limited — not exhausted — at 100% when credits remain", () => {
		// Measured during CodexProbe: primary at 100% and
		// ordinaryUsageAllowed false, yet requests still succeeded on credits.
		assert.equal(usageHeadroom({
			...base, primary: { usedPercent: 100, windowMinutes: 300, resetsAt: null },
			credits: { hasCredits: true, balance: "76.17" }, ordinaryUsageAllowed: false,
		}), "limited");
	});

	it("is exhausted only when the window is full and no credits remain", () => {
		assert.equal(usageHeadroom({
			...base, primary: { usedPercent: 100, windowMinutes: 300, resetsAt: null },
			credits: { hasCredits: false, balance: "0" }, ordinaryUsageAllowed: false,
		}), "exhausted");
	});

	it("is unknown when the window itself is missing", () => {
		assert.equal(usageHeadroom({ ...base, primary: null, credits: null, ordinaryUsageAllowed: null }), "unknown");
	});
});

describe("claudeUsageUnavailable", () => {
	it("is honest that the Claude CLI exposes no usage source", () => {
		const usage = claudeUsageUnavailable(500);
		assert.equal(usage.state, "unavailable");
		assert.equal(usage.engine, "claude");
		assert.equal(usage.fetchedAt, 500);
		assert.match(usage.reason, /no .*source/i);
	});

	it("never renders as a number", () => {
		assert.equal(describeUsageSource(claudeUsageUnavailable(0)).value, "Unavailable");
	});
});

describe("describeUsageSource", () => {
	it("reports value, source and age for a usable reading", () => {
		const d = describeUsageSource(parseCodexRateLimits(CODEX_SAMPLE, 1_000), 1_000);
		assert.equal(d.value, "100%");
		assert.match(d.source, /rateLimits/);
		assert.equal(d.stale, false);
	});

	it("marks a stale reading rather than presenting it as current", () => {
		const d = describeUsageSource(parseCodexRateLimits(CODEX_SAMPLE, 0), USAGE_STALE_MS + 1);
		assert.equal(d.stale, true);
	});

	it("never turns an unavailable reading into a zero", () => {
		const d = describeUsageSource({
			state: "unavailable", engine: "codex", source: null, reason: "spawn failed", fetchedAt: 0,
		});
		assert.equal(d.value, "Unavailable");
		assert.notEqual(d.value, "0%");
	});
});

// ---------------------------------------------------------------------------
// app-server JSON-RPC framing (newline-delimited)
// ---------------------------------------------------------------------------

describe("buildAppServerRequests", () => {
	it("sends initialize, then the initialized notification, then the read", () => {
		const msgs = buildAppServerRequests();
		assert.deepStrictEqual(msgs.map((m) => m.method), ["initialize", "initialized", "account/rateLimits/read"]);
	});

	it("gives the notification no id and the calls distinct ids", () => {
		const msgs = buildAppServerRequests();
		assert.equal(msgs[1]!.id, undefined, "notifications carry no id");
		assert.notEqual(msgs[0]!.id, msgs[2]!.id);
	});
});

describe("parseAppServerLines", () => {
	it("picks the response matching the request id", () => {
		const lines = [
			'{"jsonrpc":"2.0","id":1,"result":{"userAgent":"x"}}',
			'{"jsonrpc":"2.0","method":"someNotification","params":{}}',
			'{"jsonrpc":"2.0","id":2,"result":{"rateLimits":{"planType":"plus"}}}',
		].join("\n");
		const result = parseAppServerLines(lines, 2);
		assert.deepStrictEqual(result, { rateLimits: { planType: "plus" } });
	});

	it("ignores unparseable lines instead of failing the whole read", () => {
		const lines = ['garbage', '{"jsonrpc":"2.0","id":2,"result":{"ok":true}}'].join("\n");
		assert.deepStrictEqual(parseAppServerLines(lines, 2), { ok: true });
	});

	it("returns null when the id never answered", () => {
		assert.equal(parseAppServerLines('{"jsonrpc":"2.0","id":9,"result":{}}', 2), null);
	});

	it("returns null for a JSON-RPC error response", () => {
		assert.equal(parseAppServerLines('{"jsonrpc":"2.0","id":2,"error":{"code":-32601}}', 2), null);
	});
});
