import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lesson-completion-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const { chatStore } = await import("../src/store/chats.ts");
const { subscribe } = await import("../src/core/events.ts");
const { PUT } = await import("../app/api/chats/[id]/completion/route.ts");
const { GET } = await import("../app/api/chats/route.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function request(id: string, body: unknown) {
	return PUT(new Request(`http://localhost/api/chats/${id}/completion`, {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ id }) });
}

test("completion persists independently of unfinished checks and preserves the whole session", async () => {
	const chat = chatStore.createChat("Partial lesson");
	chatStore.saveMessages(chat.id, [{ id: "learner", role: "user", content: "Mark this lesson complete", timestamp: 1 }]);
	chatStore.saveTree(chat.id, { nodes: [{ id: "checked", title: "Checked" }, { id: "unverified", title: "Unverified" }], edges: [], version: 1, completedNodeIds: ["checked"] });
	const before = chatStore.getChat(chat.id)!;
	let events = 0;
	const off = subscribe(event => { if (event.type === "chats-changed") events++; });
	try {
		const response = await request(chat.id, { completed: true });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { lessonCompleted: true });
		assert.deepEqual(chatStore.getChat(chat.id), { ...before, lessonCompleted: true });
		const list = await (await GET()).json();
		const summary = list.chats.find((item: { id: string }) => item.id === chat.id);
		assert.equal(summary.lessonCompleted, true);
		assert.deepEqual(summary.lessonCompletion, { total: 2, completed: 1 });
		assert.equal(events, 1, "sidebar receives the completion event");
		chatStore.saveMessages(chat.id, [...before.messages, { id: "ack", role: "user", content: "Thanks", timestamp: 2 }]);
		chatStore.saveTree(chat.id, before.tree!);
		assert.equal(chatStore.getChat(chat.id)?.lessonCompleted, true, "later content writes preserve completion");
		assert.equal((await request(chat.id, { completed: false })).status, 200);
		assert.equal(chatStore.getChat(chat.id)?.lessonCompleted, false);
		assert.deepEqual(chatStore.getChat(chat.id)?.tree, before.tree);
		assert.equal(events, 2);
	} finally { off(); }
});

test("repeated completion and reopening are silent and do not rewrite storage", () => {
	const chat = chatStore.createChat("Idempotent lesson");
	const file = path.join(scratch, "chats", `${chat.id}.json`);
	for (const completed of [true, false]) {
		chatStore.setLessonCompleted(chat.id, completed);
		fs.utimesSync(file, new Date(0), new Date(0));
		const before = fs.statSync(file, { bigint: true }).mtimeNs;
		let events = 0;
		const off = subscribe(event => { if (event.type === "chats-changed") events++; });
		try {
			chatStore.setLessonCompleted(chat.id, completed);
			assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, before);
			assert.equal(events, 0);
		} finally { off(); }
	}
	assert.throws(() => chatStore.setLessonCompleted("missing", true), /Chat not found/);
});

test("completion route validates input before mutating a lesson", async () => {
	const chat = chatStore.createChat("Validation");
	const before = chatStore.getChat(chat.id);
	for (const body of [null, [], true, "true", {}, { completed: "true" }, { completed: 1 }, { completed: null }]) {
		assert.equal((await request(chat.id, body)).status, 400);
	}
	const invalid = await PUT(new Request("http://localhost/completion", { method: "PUT", body: "{" }), { params: Promise.resolve({ id: chat.id }) });
	assert.equal(invalid.status, 400);
	assert.deepEqual(chatStore.getChat(chat.id), before);
	assert.equal((await request("missing", { completed: true })).status, 404);
});
