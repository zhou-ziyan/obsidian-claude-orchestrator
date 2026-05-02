import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	resolveSessionIdByTmuxName,
	fetchSessionQueueById,
	getLighthouseQueueForTmuxName,
	clearLighthouseCache,
	LIGHTHOUSE_BASE_URL,
	type FetchLike,
} from "../src/lighthouse-client.ts";

// Tiny fetch double — captures URLs called and serves canned responses.
// Keeping this in-test (no fetch-mock dep) matches the project's "no
// third-party test deps" stance (see package.json's test script).
type Route = { ok: boolean; status?: number; body: unknown } | Error;

interface FakeFetch {
	fn: FetchLike;
	calls: string[];
}

function makeFetch(routes: Record<string, Route>): FakeFetch {
	const calls: string[] = [];
	const fn: FetchLike = async (url) => {
		calls.push(url);
		const route = routes[url];
		if (!route) {
			return {
				ok: false,
				status: 404,
				json: async () => ({}),
			};
		}
		if (route instanceof Error) {
			// Throw the actual error; the function-call detection in
			// instanceof Error doesn't trigger no-unsafe-call here.
			throw route;
		}
		return {
			ok: route.ok,
			status: route.status ?? (route.ok ? 200 : 500),
			json: async () => route.body,
		};
	};
	return { fn, calls };
}

// Module-scoped sessionsCache survives across tests; each test that
// exercises the cache calls clearLighthouseCache() inline at the top.
// node:test's beforeEach typing is `error` under the strict eslint
// config — inline reset avoids the rule without losing isolation.

describe("lighthouse-client: LIGHTHOUSE_BASE_URL", () => {
	it("exports a localhost:3000 default base URL constant", () => {
		assert.equal(LIGHTHOUSE_BASE_URL, "http://localhost:3000");
	});
});

describe("resolveSessionIdByTmuxName", () => {
	it("returns ses_xxx for a matching tmux_name", async () => {
		clearLighthouseCache();
		const fake = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: true,
				body: [
					{ id: "ses_aaa", tmux_name: "worker-1" },
					{ id: "ses_bbb", tmux_name: "worker-2" },
				],
			},
		});
		const id = await resolveSessionIdByTmuxName("worker-2", { fetch: fake.fn });
		assert.equal(id, "ses_bbb");
	});

	it("returns null when no row matches the tmux_name", async () => {
		clearLighthouseCache();
		const fake = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: true,
				body: [{ id: "ses_aaa", tmux_name: "worker-1" }],
			},
		});
		const id = await resolveSessionIdByTmuxName("not-there", { fetch: fake.fn });
		assert.equal(id, null);
	});

	it("returns null on fetch error (lighthouse unreachable / 5xx)", async () => {
		clearLighthouseCache();
		const fake = makeFetch({
			"http://localhost:3000/api/db/sessions": new Error("ECONNREFUSED"),
		});
		const id = await resolveSessionIdByTmuxName("worker-1", { fetch: fake.fn });
		assert.equal(id, null);
	});

	it("returns null on 5xx response", async () => {
		clearLighthouseCache();
		const fake = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: false,
				status: 500,
				body: {},
			},
		});
		const id = await resolveSessionIdByTmuxName("worker-1", { fetch: fake.fn });
		assert.equal(id, null);
	});

	it("caches the sessions list (second call does NOT refetch)", async () => {
		clearLighthouseCache();
		const fake = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: true,
				body: [{ id: "ses_aaa", tmux_name: "worker-1" }],
			},
		});
		await resolveSessionIdByTmuxName("worker-1", { fetch: fake.fn });
		await resolveSessionIdByTmuxName("worker-1", { fetch: fake.fn });
		const calls = fake.calls;
		assert.equal(calls.length, 1, "second call must hit the cache, not re-fetch");
	});
});

describe("fetchSessionQueueById", () => {
	it("splits queue rows by status: pending/claimed → queue, sent/done → history", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": {
				ok: true,
				body: [
					{ id: "q1", text: "do thing 1", status: "pending", position: 3 },
					{ id: "q2", text: "do thing 2", status: "claimed", position: 4 },
					{ id: "q3", text: "older sent", status: "sent", position: 1 },
					{ id: "q4", text: "newer done", status: "done", position: 2 },
					{ id: "q5", text: "ignored", status: "cancelled", position: 99 },
				],
			},
		});
		const out = await fetchSessionQueueById("ses_aaa", { fetch: fake.fn });
		assert.ok(out, "expected non-null result on 200");
		assert.deepEqual(out.queue, ["do thing 1", "do thing 2"]);
		// History sorts by position ASC so chronologically older items appear
		// first (position is per-session monotonic at insert time).
		assert.deepEqual(
			out.history.map((h) => h.text),
			["older sent", "newer done"],
		);
		// History items are HistoryItem-shaped: { text, completed }
		assert.equal(out.history[0]?.completed, false, "sent → not yet completed");
		assert.equal(out.history[1]?.completed, true, "done → completed");
	});

	it("preserves position ordering inside queue and history", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": {
				ok: true,
				body: [
					{ id: "q3", text: "third", status: "pending", position: 3 },
					{ id: "q1", text: "first", status: "pending", position: 1 },
					{ id: "q2", text: "second", status: "pending", position: 2 },
				],
			},
		});
		const out = await fetchSessionQueueById("ses_aaa", { fetch: fake.fn });
		assert.ok(out, "expected non-null result on 200");
		assert.deepEqual(out.queue, ["first", "second", "third"]);
	});

	it("returns null on fetch error (caller renders the offline banner)", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": new Error("ENETUNREACH"),
		});
		const out = await fetchSessionQueueById("ses_aaa", { fetch: fake.fn });
		assert.equal(out, null);
	});

	it("returns null on 5xx response", async () => {
		clearLighthouseCache();
		const fake = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": {
				ok: false,
				status: 503,
				body: {},
			},
		});
		const out = await fetchSessionQueueById("ses_aaa", { fetch: fake.fn });
		assert.equal(out, null);
	});

	it("returns empty queue/history on 200 with empty body (queue migrated, no items yet)", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": {
				ok: true,
				body: [],
			},
		});
		const out = await fetchSessionQueueById("ses_aaa", { fetch: fake.fn });
		assert.deepEqual(out, { queue: [], history: [] });
	});
});

describe("getLighthouseQueueForTmuxName (composed end-to-end)", () => {
	it("resolves tmux_name → session_id, then fetches queue, splits by status", async () => {
		clearLighthouseCache();
		const fake = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: true,
				body: [{ id: "ses_xyz", tmux_name: "moon-1" }],
			},
			"http://localhost:3000/api/sessions/ses_xyz/queue": {
				ok: true,
				body: [
					{ id: "q1", text: "build", status: "pending", position: 1 },
					{ id: "q2", text: "tested", status: "done", position: 0 },
				],
			},
		});
		const out = await getLighthouseQueueForTmuxName("moon-1", { fetch: fake.fn });
		assert.deepEqual(out, {
			available: true,
			queue: ["build"],
			history: [{ text: "tested", completed: true }],
		});
	});

	it("reports available:false when tmux_name has no lighthouse session row", async () => {
		clearLighthouseCache();
		const fake = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: true,
				body: [{ id: "ses_other", tmux_name: "elsewhere" }],
			},
		});
		const out = await getLighthouseQueueForTmuxName("missing", { fetch: fake.fn });
		assert.equal(out.available, false);
		assert.deepEqual(out.queue, []);
		assert.deepEqual(out.history, []);
	});

	it("reports available:false when lighthouse is unreachable (offline degrade)", async () => {
		clearLighthouseCache();
		const fake = makeFetch({
			"http://localhost:3000/api/db/sessions": new Error("ECONNREFUSED"),
		});
		const out = await getLighthouseQueueForTmuxName("any", { fetch: fake.fn });
		assert.equal(out.available, false);
	});

	it("reports available:false when /api/sessions/:id/queue fails after a successful resolve", async () => {
		clearLighthouseCache();
		const fake = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: true,
				body: [{ id: "ses_xyz", tmux_name: "moon-1" }],
			},
			"http://localhost:3000/api/sessions/ses_xyz/queue": {
				ok: false,
				status: 500,
				body: {},
			},
		});
		const out = await getLighthouseQueueForTmuxName("moon-1", { fetch: fake.fn });
		assert.equal(out.available, false);
	});
});
