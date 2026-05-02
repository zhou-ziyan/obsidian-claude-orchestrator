import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
	resolveSessionIdByTmuxName,
	fetchSessionQueueById,
	getLighthouseQueueForTmuxName,
	clearLighthouseCache,
	LIGHTHOUSE_BASE_URL,
} from "../src/lighthouse-client.ts";

// Tiny fetch double — captures URLs called and serves canned responses.
// Keeping this in-test (no fetch-mock dep) matches the project's "no
// third-party test deps" stance (see package.json's test script).
function makeFetch(routes: Record<string, { ok: boolean; status?: number; body: unknown } | Error>) {
	const calls: string[] = [];
	const fetchFn: typeof fetch = async (input) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push(url);
		const route = routes[url];
		if (!route) {
			return {
				ok: false,
				status: 404,
				json: async () => ({}),
			} as Response;
		}
		if (route instanceof Error) throw route;
		return {
			ok: route.ok,
			status: route.status ?? (route.ok ? 200 : 500),
			json: async () => route.body,
		} as Response;
	};
	(fetchFn as unknown as { calls: string[] }).calls = calls;
	return fetchFn;
}

beforeEach(() => {
	clearLighthouseCache();
});

describe("lighthouse-client: LIGHTHOUSE_BASE_URL", () => {
	it("exports a localhost:3000 default base URL constant", () => {
		assert.equal(LIGHTHOUSE_BASE_URL, "http://localhost:3000");
	});
});

describe("resolveSessionIdByTmuxName", () => {
	it("returns ses_xxx for a matching tmux_name", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: true,
				body: [
					{ id: "ses_aaa", tmux_name: "worker-1" },
					{ id: "ses_bbb", tmux_name: "worker-2" },
				],
			},
		});
		const id = await resolveSessionIdByTmuxName("worker-2", { fetch: fetchFn });
		assert.equal(id, "ses_bbb");
	});

	it("returns null when no row matches the tmux_name", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: true,
				body: [{ id: "ses_aaa", tmux_name: "worker-1" }],
			},
		});
		const id = await resolveSessionIdByTmuxName("not-there", { fetch: fetchFn });
		assert.equal(id, null);
	});

	it("returns null on fetch error (lighthouse unreachable / 5xx)", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/db/sessions": new Error("ECONNREFUSED"),
		});
		const id = await resolveSessionIdByTmuxName("worker-1", { fetch: fetchFn });
		assert.equal(id, null);
	});

	it("returns null on 5xx response", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: false,
				status: 500,
				body: {},
			},
		});
		const id = await resolveSessionIdByTmuxName("worker-1", { fetch: fetchFn });
		assert.equal(id, null);
	});

	it("caches the sessions list (second call does NOT refetch)", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: true,
				body: [{ id: "ses_aaa", tmux_name: "worker-1" }],
			},
		});
		await resolveSessionIdByTmuxName("worker-1", { fetch: fetchFn });
		await resolveSessionIdByTmuxName("worker-1", { fetch: fetchFn });
		const calls = (fetchFn as unknown as { calls: string[] }).calls;
		assert.equal(calls.length, 1, "second call must hit the cache, not re-fetch");
	});
});

describe("fetchSessionQueueById", () => {
	it("splits queue rows by status: pending/claimed → queue, sent/done → history", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": {
				ok: true,
				body: [
					{ id: "q1", text: "do thing 1", status: "pending", position: 1 },
					{ id: "q2", text: "do thing 2", status: "claimed", position: 2 },
					{ id: "q3", text: "did thing 0", status: "sent", position: 0 },
					{ id: "q4", text: "older done", status: "done", position: -1 },
					{ id: "q5", text: "ignored", status: "cancelled", position: 99 },
				],
			},
		});
		const out = await fetchSessionQueueById("ses_aaa", { fetch: fetchFn });
		assert.ok(out, "expected non-null result on 200");
		assert.deepEqual(out!.queue, ["do thing 1", "do thing 2"]);
		assert.deepEqual(
			out!.history.map((h) => h.text),
			["did thing 0", "older done"],
		);
		// History items are HistoryItem-shaped: { text, completed }
		assert.equal(out!.history[0]?.completed, false, "sent → not yet completed");
		assert.equal(out!.history[1]?.completed, true, "done → completed");
	});

	it("preserves position ordering inside queue and history", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": {
				ok: true,
				body: [
					{ id: "q3", text: "third", status: "pending", position: 3 },
					{ id: "q1", text: "first", status: "pending", position: 1 },
					{ id: "q2", text: "second", status: "pending", position: 2 },
				],
			},
		});
		const out = await fetchSessionQueueById("ses_aaa", { fetch: fetchFn });
		assert.deepEqual(out!.queue, ["first", "second", "third"]);
	});

	it("returns null on fetch error (caller renders the offline banner)", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": new Error("ENETUNREACH"),
		});
		const out = await fetchSessionQueueById("ses_aaa", { fetch: fetchFn });
		assert.equal(out, null);
	});

	it("returns null on 5xx response", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": {
				ok: false,
				status: 503,
				body: {},
			},
		});
		const out = await fetchSessionQueueById("ses_aaa", { fetch: fetchFn });
		assert.equal(out, null);
	});

	it("returns empty queue/history on 200 with empty body (queue migrated, no items yet)", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": {
				ok: true,
				body: [],
			},
		});
		const out = await fetchSessionQueueById("ses_aaa", { fetch: fetchFn });
		assert.deepEqual(out, { queue: [], history: [] });
	});
});

describe("getLighthouseQueueForTmuxName (composed end-to-end)", () => {
	it("resolves tmux_name → session_id, then fetches queue, splits by status", async () => {
		const fetchFn = makeFetch({
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
		const out = await getLighthouseQueueForTmuxName("moon-1", { fetch: fetchFn });
		assert.deepEqual(out, {
			available: true,
			queue: ["build"],
			history: [{ text: "tested", completed: true }],
		});
	});

	it("reports available:false when tmux_name has no lighthouse session row", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/db/sessions": {
				ok: true,
				body: [{ id: "ses_other", tmux_name: "elsewhere" }],
			},
		});
		const out = await getLighthouseQueueForTmuxName("missing", { fetch: fetchFn });
		assert.equal(out.available, false);
		assert.deepEqual(out.queue, []);
		assert.deepEqual(out.history, []);
	});

	it("reports available:false when lighthouse is unreachable (offline degrade)", async () => {
		const fetchFn = makeFetch({
			"http://localhost:3000/api/db/sessions": new Error("ECONNREFUSED"),
		});
		const out = await getLighthouseQueueForTmuxName("any", { fetch: fetchFn });
		assert.equal(out.available, false);
	});

	it("reports available:false when /api/sessions/:id/queue fails after a successful resolve", async () => {
		const fetchFn = makeFetch({
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
		const out = await getLighthouseQueueForTmuxName("moon-1", { fetch: fetchFn });
		assert.equal(out.available, false);
	});
});
