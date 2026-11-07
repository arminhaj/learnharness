import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lesson-completion-tool-"));
process.env.LH_DATA_DIR = scratch;

const { chatStore } = await import("../src/store/chats.ts");
const { planTools } = await import("../src/agent/tools/plan.ts");
const { sessionSection } = await import("../src/core/session-sections.ts");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

async function update(chatId: string, completed: boolean) {
	const tool = planTools({ chatId, chatStore }).lesson_set_completed!;
	return tool.execute("lesson-completion-test", { completed });
}

function section(chatId: string) {
	const summary = chatStore.listChats().find(chat => chat.id === chatId)!;
	return sessionSection({ ...summary, busy: false, compacting: false });
}

test("whole-lesson completion persists separately from unfinished checks and plan evidence", async () => {
	const chat = chatStore.createChat("Unverified final check");
	chatStore.saveMessages(chat.id, [{ id: "mark-complete", role: "user", content: "Mark this lesson complete", timestamp: 1 }]);
	chatStore.saveTree(chat.id, {
		nodes: [{ id: "checked", title: "Checked step" }, { id: "unverified", title: "Unverified step" }],
		edges: [{ from: "checked", to: "unverified" }], version: 2, completedNodeIds: ["checked"],
	});
	const before = chatStore.getChat(chat.id)!;
	assert.equal(section(chat.id), "active");

	const result = await update(chat.id, true);
	assert.deepEqual(result.details, { ok: true, completed: true });
	assert.deepEqual(chatStore.getChat(chat.id), { ...before, lessonCompleted: true }, "no transcript, plan completion, plan version, or activity timestamp changes");
	assert.deepEqual(chatStore.listChats().find(item => item.id === chat.id)!.lessonCompletion, { total: 2, completed: 1 });
	assert.equal(section(chat.id), "completed");
	assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, "chats", `${chat.id}.json`), "utf8")).lessonCompleted, true);
	assert.deepEqual((await update(chat.id, true)).details, result.details, "repeated completion has the same result");
});

test("lesson completion is available without a plan, and reopening preserves completed plan steps", async () => {
	const chat = chatStore.createChat("Lesson without a plan");
	assert.deepEqual((await update(chat.id, true)).details, { ok: true, completed: true });
	assert.equal(chatStore.getChat(chat.id)!.tree, undefined);
	assert.equal(section(chat.id), "completed");

	chatStore.saveTree(chat.id, {
		nodes: [{ id: "checked", title: "Verified step" }], edges: [], version: 1, completedNodeIds: ["checked"],
	});
	const beforeReopen = chatStore.getChat(chat.id)!;
	assert.deepEqual((await update(chat.id, false)).details, { ok: true, completed: false });
	assert.deepEqual(chatStore.getChat(chat.id), { ...beforeReopen, lessonCompleted: false });
	assert.equal(section(chat.id), "active", "explicit reopen overrides all-plan completion without erasing evidence");
});

test("unknown lessons return a failed tool result without creating records", async () => {
	fs.mkdirSync(path.join(scratch, "chats"), { recursive: true });
	const before = fs.readdirSync(path.join(scratch, "chats"));
	assert.deepEqual((await update("chat_missing_lesson_completion", true)).details, {
		ok: false, error: "Chat not found: chat_missing_lesson_completion",
	});
	assert.deepEqual(fs.readdirSync(path.join(scratch, "chats")), before);
});
