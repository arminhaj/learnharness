import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Resolve storage only after the isolated data seam is installed.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-archive-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });

const { chatStore } = await import("../src/store/chats.ts");
const { subscribe } = await import("../src/core/events.ts");
const { PUT } = await import("../app/api/chats/[id]/archive/route.ts");
const { GET: listSessions } = await import("../app/api/chats/route.ts");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function chatFile(id: string): string {
	return path.join(scratch, "chats", `${id}.json`);
}

function archiveRequest(id: string, body: unknown): Promise<Response> {
	return PUT(new Request(`http://localhost/api/chats/${id}/archive`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}), { params: Promise.resolve({ id }) });
}

test("archive and restore preserve session content, activity order, and source history", () => {
	const chat = chatStore.createChat("Preserved lesson");
	chatStore.saveMessages(chat.id, [{ id: "learner-1", role: "user", content: "My explanation", timestamp: 1 }]);
	chatStore.saveTree(chat.id, {
		nodes: [{ id: "first", title: "First" }, { id: "last", title: "Last" }],
		edges: [{ from: "first", to: "last" }], version: 3, completedNodeIds: ["first"],
	});
	chatStore.saveSettings(chat.id, { model: { provider: "chatgpt", id: "fixture" }, thinkingLevel: "low" });
	chatStore.appendTurnUsage(chat.id, { id: "turn-1", messageId: "learner-1", at: "fixture", model: "chatgpt:fixture", steps: [] });
	chatStore.appendExtractionUsage(chat.id, {
		startedAt: 1, at: "fixture", durationMs: 4,
		stages: { extractor: { model: "fixture", steps: [] }, auditor: { model: "fixture", steps: [] } },
	});
	const draftDir = path.join(scratch, "chats", "drafts");
	const graphDir = path.join(scratch, "graph");
	fs.mkdirSync(draftDir, { recursive: true });
	fs.mkdirSync(graphDir, { recursive: true });
	const draftFile = path.join(draftDir, `${chat.id}.json`);
	const ledgerFile = path.join(graphDir, "nodes.jsonl");
	fs.writeFileSync(draftFile, '{"text":"unsent reflection"}');
	fs.writeFileSync(ledgerFile, '{"id":"preserved-source"}\n');
	const before = chatStore.getChat(chat.id)!;
	let announcements = 0;
	const off = subscribe(event => { if (event.type === "chats-changed") announcements++; });
	try {
		const archived = chatStore.setArchived(chat.id, true);
		assert.ok(archived.archivedAt && Number.isFinite(Date.parse(archived.archivedAt)));
		const { archivedAt: _archivedAt, ...preserved } = archived;
		assert.deepEqual(preserved, before, "archiving changes no transcript, tree, usage, settings, or activity timestamps");
		const listed = chatStore.listChats().find(item => item.id === chat.id)!;
		assert.equal(listed.archivedAt, archived.archivedAt, "internal enumeration retains archived sessions");
		assert.deepEqual(listed.lessonCompletion, { total: 2, completed: 1 });
		assert.equal("lessonCompletion" in JSON.parse(fs.readFileSync(chatFile(chat.id), "utf8")), false);
		assert.equal(announcements, 1);

		const restored = chatStore.setArchived(chat.id, false);
		assert.deepEqual(restored, before, "restore recovers the original record without changing activity order");
		assert.equal(announcements, 2);
		assert.equal(fs.readFileSync(draftFile, "utf8"), '{"text":"unsent reflection"}');
		assert.equal(fs.readFileSync(ledgerFile, "utf8"), '{"id":"preserved-source"}\n');
	} finally {
		off();
	}
});

test("repeating archive or restore is silent and does not rewrite the record", () => {
	const chat = chatStore.createChat("Idempotent archive");
	let announcements = 0;
	const off = subscribe(event => { if (event.type === "chats-changed") announcements++; });
	try {
		for (const archived of [false, true]) {
			if (archived) chatStore.setArchived(chat.id, true);
			const file = chatFile(chat.id);
			const bytes = fs.readFileSync(file, "utf8");
			// A rewrite cannot hide behind the filesystem's clock precision.
			fs.utimesSync(file, new Date(0), new Date(0));
			const mtime = fs.statSync(file, { bigint: true }).mtimeNs;
			const events = announcements;
			chatStore.setArchived(chat.id, archived);
			assert.equal(fs.readFileSync(file, "utf8"), bytes);
			assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, mtime);
			assert.equal(announcements, events);
		}
	} finally {
		off();
	}
	assert.throws(() => chatStore.setArchived("chat_missing_archive", true), /Chat not found/);
});

test("completion summaries use explicit current-plan IDs and are derived on every read", () => {
	const chat = chatStore.createChat("Completion projection");
	assert.equal(chatStore.listChats().find(item => item.id === chat.id)!.lessonCompletion, undefined);
	chatStore.saveTree(chat.id, {
		nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }], edges: [], version: 1,
		completedNodeIds: ["a", "a", "removed"],
	});
	assert.deepEqual(chatStore.listChats().find(item => item.id === chat.id)!.lessonCompletion, { total: 2, completed: 1 });
	chatStore.saveTree(chat.id, { nodes: [{ id: "b", title: "B" }], edges: [], version: 2, completedNodeIds: ["a"] });
	assert.deepEqual(chatStore.listChats().find(item => item.id === chat.id)!.lessonCompletion, { total: 1, completed: 0 });
	assert.equal("lessonCompletion" in chatStore.getChat(chat.id)!, false);
});

test("archive endpoint accepts booleans, keeps archived sessions readable, and restores them", async () => {
	const chat = chatStore.createChat("Route archive");
	const first = await archiveRequest(chat.id, { archived: true });
	assert.equal(first.status, 200);
	const result = await first.json() as { archivedAt: string };
	assert.ok(Number.isFinite(Date.parse(result.archivedAt)));
	const repeat = await archiveRequest(chat.id, { archived: true });
	assert.deepEqual(await repeat.json(), result);
	const list = await (await listSessions()).json() as { chats: Array<{ id: string; archivedAt?: string }> };
	assert.equal(list.chats.find(item => item.id === chat.id)?.archivedAt, result.archivedAt);
	const restored = await archiveRequest(chat.id, { archived: false });
	assert.equal(restored.status, 200);
	assert.deepEqual(await restored.json(), { archivedAt: null });
	assert.ok(chatStore.getChat(chat.id));
});

test("archive endpoint rejects malformed input without touching an existing session", async () => {
	const chat = chatStore.createChat("Invalid archive input");
	const before = fs.readFileSync(chatFile(chat.id), "utf8");
	for (const body of [null, [], true, "true", {}, { archived: "true" }, { archived: 1 }, { archived: null }]) {
		const response = await archiveRequest(chat.id, body);
		assert.equal(response.status, 400);
	}
	const invalidJson = await PUT(new Request(`http://localhost/api/chats/${chat.id}/archive`, {
		method: "PUT", body: "{",
	}), { params: Promise.resolve({ id: chat.id }) });
	assert.equal(invalidJson.status, 400);
	assert.equal(fs.readFileSync(chatFile(chat.id), "utf8"), before);
	assert.equal((await archiveRequest("chat_missing_route", { archived: true })).status, 404);
});
