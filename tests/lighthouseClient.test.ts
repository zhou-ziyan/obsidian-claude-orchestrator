import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	resolveSessionIdByTmuxName,
	fetchSessionQueueById,
	getLighthouseQueueForTmuxName,
	enqueueQueueItem,
	updateQueueItem,
	deleteQueueItem,
	clearLighthouseCache,
	LIGHTHOUSE_BASE_URL,
	type FetchLike,
} from "../src/lighthouse-client.ts";

// Tiny fetch double — captures URLs called and serves canned responses.
// Keeping this in-test (no fetch-mock dep) matches the project's "no
// third-party test deps" stance (see package.json's test script).
type Route = { ok: boolean; status?: number; body: unknown } | Error;

interface FakeCall {
	url: string;
	method: string;
	body: string | null;
}

interface FakeFetch {
	fn: FetchLike;
	calls: FakeCall[];
}

function makeFetch(routes: Record<string, Route>): FakeFetch {
	const calls: FakeCall[] = [];
	const fn: FetchLike = async (url, init) => {
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? init.body : null;
		calls.push({ url, method, body });
		const route = routes[url];
		if (!route) {
			return {
				ok: false,
				status: 404,
				json: async () => ({}),
			};
		}
		if (route instanceof Error) {
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
		// M7: queue items carry their lighthouse id alongside the text so
		// downstream PATCH/DELETE handlers can address the right row.
		assert.deepEqual(out.queue, [
			{ id: "q1", text: "do thing 1" },
			{ id: "q2", text: "do thing 2" },
		]);
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
		assert.deepEqual(out.queue.map((q) => q.text), ["first", "second", "third"]);
		assert.deepEqual(out.queue.map((q) => q.id), ["q1", "q2", "q3"]);
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
			queue: [{ id: "q1", text: "build" }],
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

// --- Write APIs (M7 stage 2) ---

describe("enqueueQueueItem", () => {
	it("POSTs text to /api/sessions/<sid>/queue and returns the inserted row id", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": {
				ok: true,
				body: { id: "qi_001", text: "do it", status: "pending", position: 7 },
			},
		});
		const out = await enqueueQueueItem("ses_aaa", "do it", { fetch: fake.fn });
		assert.deepEqual(out, { id: "qi_001" });
		assert.equal(fake.calls.length, 1);
		assert.equal(fake.calls[0]?.method, "POST");
		assert.match(fake.calls[0]?.body ?? "", /"text":\s*"do it"/);
	});

	it("returns null on 5xx (caller can show offline notice)", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": {
				ok: false,
				status: 500,
				body: {},
			},
		});
		const out = await enqueueQueueItem("ses_aaa", "do it", { fetch: fake.fn });
		assert.equal(out, null);
	});

	it("returns null when fetch throws (lighthouse unreachable)", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/sessions/ses_aaa/queue": new Error("ECONNREFUSED"),
		});
		const out = await enqueueQueueItem("ses_aaa", "do it", { fetch: fake.fn });
		assert.equal(out, null);
	});

	it("URL-encodes the session id (defensive against weird characters)", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/sessions/ses%2Fwith%20space/queue": {
				ok: true,
				body: { id: "qi_001" },
			},
		});
		const out = await enqueueQueueItem("ses/with space", "do it", { fetch: fake.fn });
		assert.deepEqual(out, { id: "qi_001" });
	});
});

describe("updateQueueItem", () => {
	it("PATCHes text to /api/queue/<qid> and returns true on 200", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/queue/qi_001": {
				ok: true,
				body: { id: "qi_001", text: "edited", status: "pending" },
			},
		});
		const ok = await updateQueueItem("qi_001", { text: "edited" }, { fetch: fake.fn });
		assert.equal(ok, true);
		assert.equal(fake.calls[0]?.method, "PATCH");
		assert.match(fake.calls[0]?.body ?? "", /"text":\s*"edited"/);
	});

	it("PATCHes status (used by Send-next ▶ to mark sent or by user to cancel)", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/queue/qi_001": {
				ok: true,
				body: { id: "qi_001", status: "sent" },
			},
		});
		const ok = await updateQueueItem("qi_001", { status: "sent" }, { fetch: fake.fn });
		assert.equal(ok, true);
		assert.match(fake.calls[0]?.body ?? "", /"status":\s*"sent"/);
	});

	it("returns false on 5xx", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/queue/qi_001": {
				ok: false,
				status: 500,
				body: {},
			},
		});
		const ok = await updateQueueItem("qi_001", { text: "x" }, { fetch: fake.fn });
		assert.equal(ok, false);
	});

	it("returns false when fetch throws", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/queue/qi_001": new Error("ENETUNREACH"),
		});
		const ok = await updateQueueItem("qi_001", { text: "x" }, { fetch: fake.fn });
		assert.equal(ok, false);
	});
});

describe("deleteQueueItem", () => {
	it("DELETEs /api/queue/<qid> and returns true on 200", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/queue/qi_001": {
				ok: true,
				body: { ok: true, id: "qi_001" },
			},
		});
		const ok = await deleteQueueItem("qi_001", { fetch: fake.fn });
		assert.equal(ok, true);
		assert.equal(fake.calls[0]?.method, "DELETE");
	});

	it("returns false on 404 (already deleted / never existed)", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/queue/missing": {
				ok: false,
				status: 404,
				body: { error: "not found" },
			},
		});
		const ok = await deleteQueueItem("missing", { fetch: fake.fn });
		assert.equal(ok, false);
	});

	it("returns false when fetch throws", async () => {
		const fake = makeFetch({
			"http://localhost:3000/api/queue/qi_001": new Error("ECONNREFUSED"),
		});
		const ok = await deleteQueueItem("qi_001", { fetch: fake.fn });
		assert.equal(ok, false);
	});
});
