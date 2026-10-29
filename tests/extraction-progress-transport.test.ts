import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, mock } from "node:test";
import type { RunningExtraction } from "../src/agent/subagents/extraction.ts";

// Keep every transport check away from real conversations and credentials.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-progress-transport-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
fs.writeFileSync(process.env.LH_AUTH_FILE, JSON.stringify({ OPENROUTER_API_KEY: "fixture-key" }));

const { GET } = await import("../app/api/graph/status/route.ts");
const { POST } = await import("../app/api/graph/learning/refresh/route.ts");
const { activityFeed, extraction, stores } = await import("../src/server/index.ts");
const registry = (globalThis as typeof globalThis & {
	__lhExtractionRuns?: { running: Map<string, RunningExtraction>; inFlight: Set<string>; lastStartedAt: number };
});

after(() => {
	mock.restoreAll();
	registry.__lhExtractionRuns?.running.clear();
	fs.rmSync(directory, { recursive: true, force: true });
});

test("graph and sidebar transports expose matching live metadata without internal handles", async () => {
	const chat = stores.chatStore.createChat("Progress fixture");
	const progress = {
		activity: "thinking" as const, lastActivityAt: 1250, modelTurn: 1, maxModelTurns: 8,
		receivedEvents: 5, outputChars: 0, sourceStartedAt: 1000,
		batch: { current: 2, total: 4, completed: 1 }, lastSavedAt: 1100,
		saved: { nodes: 3, prerequisites: 2, groups: 1 },
	};
	registry.__lhExtractionRuns = {
		running: new Map([[`${chat.id}#2`, {
			chatId: chat.id, kind: "chat", label: "Learning map · Progress fixture", part: { i: 2, n: 4 },
			phase: "extracting", startedAt: 1200, usage: {}, progress, controller: new AbortController(),
		}]]), inFlight: new Set([chat.id]), lastStartedAt: 1200,
	};
	try {
		const response = await GET();
		const payload = await response.json();
		assert.deepEqual(payload.runs[0].progress, progress);
		assert.deepEqual(activityFeed().extractions[0]!.progress, progress);
		assert.equal("controller" in payload.runs[0], false);
		assert.equal("messages" in payload.runs[0], false);
	} finally { registry.__lhExtractionRuns.running.clear(); }
});

test("incremental refresh preserves normal checkpoint semantics and default refresh stays forced", async () => {
	const chat = stores.chatStore.createChat("Incremental fixture");
	stores.settingsStore.writeSettings({ version: 1, models: { cheap: {
		model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low",
	} }, graph: { enabled: true } });
	const calls: unknown[] = [];
	assert.ok(extraction.updateLearning);
	const mocked = mock.method(extraction as typeof extraction & { updateLearning: NonNullable<typeof extraction.updateLearning> }, "updateLearning", async (...args: unknown[]) => { calls.push(args); });
	const post = (body: unknown) => POST(new Request("http://localhost/api/graph/learning/refresh", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
	}));
	try {
		assert.equal((await post({ chatId: chat.id, incremental: true })).status, 202);
		assert.deepEqual(calls[0], [chat.id, { force: false }]);
		assert.equal((await post({ chatId: chat.id })).status, 202);
		assert.deepEqual(calls[1], [chat.id, { force: true }]);
		assert.equal((await post({ chatId: chat.id, incremental: "yes" })).status, 400);
		assert.equal(calls.length, 2);
	} finally { mocked.mock.restore(); }
});
