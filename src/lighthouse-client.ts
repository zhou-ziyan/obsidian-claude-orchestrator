// lighthouse-client — read + write the lighthouse SQLite-backed queue.
// M6 (Read): Queue / History display sources from /api/sessions/<id>/queue.
// M7 (Write): Quick Reply / Send-next / Edit / Delete go through
//   POST/PATCH/DELETE here too. Auto countdown is gone — lighthouse
//   Job B owns dispatch.
//
// All exports are pure HTTP wrappers behind an injectable transport so
// tests in tests/lighthouseClient.test.ts can run without a live
// lighthouse and without pulling in `obsidian` as a test dep. Failure
// modes return null / false / available:false so callers can render an
// offline banner and degrade gracefully (mac-mini off, Tailscale down).

import type { HistoryItem } from "./utils";

export const LIGHTHOUSE_BASE_URL = "http://localhost:3000";

interface LighthouseSessionRow {
	id: string;
	tmux_name: string;
}

interface LighthouseQueueRow {
	id: string;
	text: string;
	status: string;
	position: number;
}

// FetchLike — minimum surface tests need to inject. Matches the global
// `fetch` shape so test code can pass a fetch double directly without
// boxing into a transport type. The optional `init` carries method +
// body for the write paths (POST/PATCH/DELETE); tests assert on it.
export interface FetchLikeInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

export type FetchLike = (
	url: string,
	init?: FetchLikeInit,
) => Promise<{
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}>;

export interface ClientOpts {
	fetch?: FetchLike;
	baseUrl?: string;
}

// Production transport — wraps Obsidian's requestUrl in a
// fetch-compatible facade so the rest of the module can stay
// framework-agnostic. The `obsidian` package is provided by the host at
// runtime and isn't a real npm dep, so we lazy-import inside the
// closure: tests that always pass `opts.fetch` never trigger the
// import and therefore don't need to mock the Obsidian module.
const defaultFetch: FetchLike = async (url, init) => {
	try {
		const obsidian = (await import("obsidian")) as {
			requestUrl: (req: {
				url: string;
				method?: string;
				headers?: Record<string, string>;
				body?: string;
				throw?: boolean;
			}) => Promise<{ status: number; json: unknown }>;
		};
		const res = await obsidian.requestUrl({
			url,
			method: init?.method ?? "GET",
			headers: init?.headers,
			body: init?.body,
			throw: false,
		});
		return {
			ok: res.status >= 200 && res.status < 300,
			status: res.status,
			json: async (): Promise<unknown> => res.json,
		};
	} catch {
		return { ok: false, status: 0, json: async () => null };
	}
};

// Module-scoped cache of the /api/db/sessions list keyed by base URL.
// Two reasons to cache: (1) the SM card preview path runs per-render;
// hitting lighthouse N times per refresh-tick is wasteful. (2) fetching
// queue for a tmux_name needs the id resolution every time. We trade
// staleness for cost — fresh entries land via clearLighthouseCache()
// after operations that mutate the session list (kill / spawn).
const sessionsCache = new Map<string, LighthouseSessionRow[]>();

export function clearLighthouseCache(): void {
	sessionsCache.clear();
}

async function fetchSessionsList(opts: ClientOpts): Promise<LighthouseSessionRow[] | null> {
	const fetchFn = opts.fetch ?? defaultFetch;
	const baseUrl = opts.baseUrl ?? LIGHTHOUSE_BASE_URL;
	const cached = sessionsCache.get(baseUrl);
	if (cached) return cached;
	try {
		const res = await fetchFn(`${baseUrl}/api/db/sessions`);
		if (!res.ok) return null;
		const body = (await res.json()) as LighthouseSessionRow[];
		if (!Array.isArray(body)) return null;
		sessionsCache.set(baseUrl, body);
		return body;
	} catch {
		return null;
	}
}

export async function resolveSessionIdByTmuxName(
	tmuxName: string,
	opts: ClientOpts = {},
): Promise<string | null> {
	const list = await fetchSessionsList(opts);
	if (!list) return null;
	const match = list.find((row) => row.tmux_name === tmuxName);
	return match ? match.id : null;
}

// QueueItemView — minimum shape the plugin needs to render + address
// queue items. The id is required for PATCH / DELETE; text is what we
// show in the row.
export interface QueueItemView {
	id: string;
	text: string;
}

export interface LighthouseQueueSplit {
	queue: QueueItemView[];
	history: HistoryItem[];
}

// Status partitioning mirrors the queue_item state machine from
// [[Always_On_Agent_Backend_Design]]: pending / claimed sit in the
// active queue (waiting to send); sent / done belong to history (sent
// already → just-sent or stop-hook'd to done). cancelled rows are
// hidden from both views — they exist for audit, not display.
const QUEUE_STATUSES = new Set(["pending", "claimed"]);
const HISTORY_STATUSES = new Set(["sent", "done"]);

export async function fetchSessionQueueById(
	sessionId: string,
	opts: ClientOpts = {},
): Promise<LighthouseQueueSplit | null> {
	const fetchFn = opts.fetch ?? defaultFetch;
	const baseUrl = opts.baseUrl ?? LIGHTHOUSE_BASE_URL;
	try {
		const res = await fetchFn(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/queue`);
		if (!res.ok) return null;
		const body = (await res.json()) as LighthouseQueueRow[];
		if (!Array.isArray(body)) return null;
		const sorted = [...body].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
		const queue: QueueItemView[] = [];
		const history: HistoryItem[] = [];
		for (const row of sorted) {
			if (QUEUE_STATUSES.has(row.status)) {
				queue.push({ id: row.id, text: row.text });
			} else if (HISTORY_STATUSES.has(row.status)) {
				history.push({ text: row.text, completed: row.status === "done" });
			}
		}
		return { queue, history };
	} catch {
		return null;
	}
}

export interface LighthouseQueueResult {
	available: boolean;
	queue: QueueItemView[];
	history: HistoryItem[];
}

const offlineResult = (): LighthouseQueueResult => ({ available: false, queue: [], history: [] });

export async function getLighthouseQueueForTmuxName(
	tmuxName: string,
	opts: ClientOpts = {},
): Promise<LighthouseQueueResult> {
	const sessionId = await resolveSessionIdByTmuxName(tmuxName, opts);
	if (!sessionId) return offlineResult();
	const split = await fetchSessionQueueById(sessionId, opts);
	if (!split) return offlineResult();
	return { available: true, queue: split.queue, history: split.history };
}

// --- Write paths (M7) ---

const JSON_HEADERS = { "Content-Type": "application/json" };

// enqueueQueueItem — POST a new queue item to lighthouse. Used by
// Quick Reply, the queue add-input, and Send-next ▶'s "cancel + reenqueue"
// path. Returns the inserted row's id on success so callers can chain
// PATCHes; returns null if the request fails.
export async function enqueueQueueItem(
	sessionId: string,
	text: string,
	opts: ClientOpts = {},
): Promise<{ id: string } | null> {
	const fetchFn = opts.fetch ?? defaultFetch;
	const baseUrl = opts.baseUrl ?? LIGHTHOUSE_BASE_URL;
	try {
		const res = await fetchFn(
			`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/queue`,
			{
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({ text }),
			},
		);
		if (!res.ok) return null;
		const body = (await res.json()) as { id?: string } | null;
		if (!body || typeof body.id !== "string") return null;
		return { id: body.id };
	} catch {
		return null;
	}
}

// updateQueueItem — PATCH allow-listed fields (text / status / task_id).
// Used by inline edit (text), Send-next ▶ (status='sent' bookkeeping), and
// any cancel flow (status='cancelled'). Returns true on 200, false otherwise.
//
// Note: position is NOT in lighthouse's PATCH allow-list (DAO ALLOWED_FIELDS
// = {text, status, task_id}). Reorder handlers should follow up via a
// separate intake to expand the allow-list rather than DELETE+POST en masse.
export interface QueueItemPatch {
	text?: string;
	status?: string;
	task_id?: string | null;
}

export async function updateQueueItem(
	queueItemId: string,
	patch: QueueItemPatch,
	opts: ClientOpts = {},
): Promise<boolean> {
	const fetchFn = opts.fetch ?? defaultFetch;
	const baseUrl = opts.baseUrl ?? LIGHTHOUSE_BASE_URL;
	try {
		const res = await fetchFn(
			`${baseUrl}/api/queue/${encodeURIComponent(queueItemId)}`,
			{
				method: "PATCH",
				headers: JSON_HEADERS,
				body: JSON.stringify(patch),
			},
		);
		return res.ok;
	} catch {
		return false;
	}
}

// deleteQueueItem — remove a queue row by id. Routes 404 → false so the
// caller can decide whether to surface a notice (already deleted is
// usually a no-op user-facing).
export async function deleteQueueItem(
	queueItemId: string,
	opts: ClientOpts = {},
): Promise<boolean> {
	const fetchFn = opts.fetch ?? defaultFetch;
	const baseUrl = opts.baseUrl ?? LIGHTHOUSE_BASE_URL;
	try {
		const res = await fetchFn(
			`${baseUrl}/api/queue/${encodeURIComponent(queueItemId)}`,
			{ method: "DELETE" },
		);
		return res.ok;
	} catch {
		return false;
	}
}
