// lighthouse-client — fetch worker queue / history from the lighthouse
// SQLite-backed API instead of the vault session note's `## Queue` /
// `## History` sections. M6 stage 1 of the read-side migration; write
// paths (Quick Reply / drag / delete / Auto countdown) still go through
// the vault and are addressed in M7.
//
// Network calls go through Obsidian's `requestUrl` in production
// (bypasses the renderer's mixed-content / CORS gate against
// http://localhost:3000) but the underlying transport is injectable so
// tests in tests/lighthouseClient.test.ts can run without a live
// lighthouse and without pulling in `obsidian` as a test dep. Failure
// modes return null / available:false so callers can render an offline
// banner and degrade gracefully (mac-mini off, Tailscale down, ...).

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
// boxing into a transport type.
export type FetchLike = (
	url: string,
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
const defaultFetch: FetchLike = async (url) => {
	try {
		const obsidian = (await import("obsidian")) as {
			requestUrl: (req: { url: string; method?: string; throw?: boolean }) => Promise<{ status: number; json: unknown }>;
		};
		const res = await obsidian.requestUrl({ url, method: "GET", throw: false });
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

export interface LighthouseQueueSplit {
	queue: string[];
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
		const queue: string[] = [];
		const history: HistoryItem[] = [];
		for (const row of sorted) {
			if (QUEUE_STATUSES.has(row.status)) {
				queue.push(row.text);
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
	queue: string[];
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
