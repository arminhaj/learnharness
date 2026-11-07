import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSessionsForSidebar, sessionSection } from "../src/core/session-sections.ts";
import type { ChatListItem } from "../src/core/contracts/chat.ts";

const now = new Date(2026, 10, 5, 12);
function chat(id: string, overrides: Partial<ChatListItem> = {}): ChatListItem {
	return { id, title: id, kind: "teach", createdAt: now.toISOString(), updatedAt: now.toISOString(), messageCount: 2, phase: "teach", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false, ...overrides };
}

test("only exact, nonempty completion moves settled lessons into Completed", () => {
	assert.equal(sessionSection(chat("complete", { lessonCompletion: { total: 3, completed: 3 } })), "completed");
	for (const lessonCompletion of [undefined, { total: 0, completed: 0 }, { total: 201, completed: 200 }]) {
		assert.equal(sessionSection(chat("incomplete", { lessonCompletion })), "active");
	}
	assert.equal(Math.round(100 * 200 / 201), 100, "an incomplete large plan can display a rounded 100%");
	assert.equal(sessionSection(chat("practice", { kind: "practice" })), "active");
	for (const state of [{ busy: true }, { compacting: true }]) {
		assert.equal(sessionSection(chat("running", { lessonCompletion: { total: 3, completed: 3 }, ...state })), "active");
	}
});

test("explicit completion and reopening override verification without changing plan progress", () => {
	const partial = chat("partial", { lessonCompletion: { total: 13, completed: 12 } });
	assert.equal(sessionSection({ ...partial, lessonCompleted: true }), "completed");
	assert.equal(sessionSection(chat("no-plan", { lessonCompleted: true })), "completed");
	assert.equal(sessionSection(chat("reopened", { lessonCompleted: false, lessonCompletion: { total: 1, completed: 1 } })), "active");
	assert.equal(sessionSection({ ...partial, lessonCompleted: true, busy: true }), "active");
	assert.equal(sessionSection({ ...partial, lessonCompleted: true, compacting: true }), "active");
	assert.equal(sessionSection({ ...partial, lessonCompleted: true, archivedAt: now.toISOString() }), "archive");
	const groups = groupSessionsForSidebar([partial, { ...partial, id: "finished", lessonCompleted: true }], now);
	assert.deepEqual(groups.find(group => group.key === "completed")?.sessions.map(item => item.id), ["finished"]);
	assert.deepEqual(partial.lessonCompletion, { total: 13, completed: 12 });
});

test("archive takes precedence; restore uses current progress and resumed work returns to active", () => {
	const complete = chat("done", { lessonCompletion: { total: 2, completed: 2 } });
	const archived = { ...complete, archivedAt: now.toISOString() };
	assert.equal(sessionSection(archived), "archive");
	assert.equal(sessionSection({ ...archived, archivedAt: undefined }), "completed");
	assert.equal(sessionSection({ ...archived, archivedAt: undefined, lessonCompletion: { total: 3, completed: 2 } }), "active");
	assert.equal(sessionSection({ ...archived, archivedAt: undefined, busy: true }), "active");
});

test("sidebar partitions every session once and preserves activity ordering and empty destinations", () => {
	const sessions = [
		chat("older", { updatedAt: new Date(2026, 9, 1).toISOString() }),
		chat("done-old", { updatedAt: new Date(2026, 9, 2).toISOString(), lessonCompletion: { total: 1, completed: 1 } }),
		chat("archived", { archivedAt: now.toISOString(), lessonCompletion: { total: 1, completed: 1 } }),
		chat("today"),
		chat("done-new", { lessonCompletion: { total: 1, completed: 1 } }),
	];
	const groups = groupSessionsForSidebar(sessions, now);
	assert.deepEqual(groups.map(group => [group.label, group.sessions.map(item => item.id)]), [
		["Today", ["today"]], ["Older", ["older"]], ["Completed", ["done-new", "done-old"]], ["Archive", ["archived"]],
	]);
	assert.equal(new Set(groups.flatMap(group => group.sessions.map(item => item.id))).size, sessions.length);
	assert.deepEqual(groupSessionsForSidebar([], now).map(group => [group.key, group.sessions.length]), [["completed", 0], ["archive", 0]]);
});
