import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exploration-delete-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { stores } = await import("../src/server/stores.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { ensureCompacted } = await import("../src/server/compaction.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

function lesson() {
	const parent = stores.chatStore.createChat("Lesson");
	const child = stores.chatStore.createChat("Exploration", undefined, {
		exploration: { parentChatId: parent.id, sourceMessageId: "source", parentTitle: parent.title, topic: "Examples", status: "active" },
	});
	for (const chat of [parent, child]) {
		stores.graphStore.appendNode({
			id: `node_${chat.id}`, name: chat.title, statement: chat.title, aliases: [], createdAt: chat.createdAt,
			provenance: [{ chatId: chat.id, messageId: "passage", ...(chat.exploration ? { subjectId: parent.id } : {}) }],
		});
		stores.graphStore.appendCoverage({ chatId: chat.id, fp: chat.id, tokens: 1, foldedAt: chat.createdAt });
	}
	return { parent, child };
}

test("lesson deletion gates running explorations before touching any record or graph", async () => {
	const { parent, child } = lesson();
	const before = stores.graphStore.readNodes();
	beginTurn(child.id);
	try {
		const result = await deleteChatSession(parent.id, "delete-nodes");
		assert.ok(!result.ok && result.status === 409);
		assert.ok(stores.chatStore.getChat(parent.id));
		assert.ok(stores.chatStore.getChat(child.id));
		assert.deepEqual(stores.graphStore.readNodes(), before);
	} finally { endTurn(child.id); }
	const result = await deleteChatSession(parent.id, "delete-nodes");
	assert.ok(result.ok);
	assert.equal(result.stats.nodesRemoved, 2);
	assert.equal(result.stats.coverageRemoved, 2);
	assert.equal(stores.chatStore.getChat(parent.id), null);
	assert.equal(stores.chatStore.getChat(child.id), null);
});

test("preserve-graph removes the whole lesson family but retains actual source provenance", async () => {
	const { parent, child } = lesson();
	const before = stores.graphStore.readNodes();
	const job = stores.jobStore.createJob({ kind: "research", chatId: child.id, toolCallId: "finished" });
	stores.jobStore.updateJob(job.id, { status: "done" });
	const result = await deleteChatSession(parent.id, "preserve-graph");
	assert.ok(result.ok);
	assert.equal(result.stats.nodesRemoved, 0);
	assert.equal(result.stats.coverageRemoved, 2);
	assert.equal(result.jobsRemoved, 1);
	assert.deepEqual(stores.graphStore.readNodes(), before);
	assert.equal(stores.chatStore.getChat(parent.id), null);
	assert.equal(stores.chatStore.getChat(child.id), null);
	assert.equal(stores.jobStore.getJob(job.id), null);
});

test("direct exploration deletion leaves its parent record and graph contribution intact", async () => {
	const { parent, child } = lesson();
	const before = stores.chatStore.getChat(parent.id);
	const result = await deleteChatSession(child.id, "delete-nodes");
	assert.ok(result.ok);
	assert.equal(result.stats.nodesRemoved, 1);
	assert.deepEqual(stores.chatStore.getChat(parent.id), before);
	assert.ok(stores.graphStore.readNodes().some((node) => node.id === `node_${parent.id}`));
	assert.equal(stores.chatStore.getChat(child.id), null);
});

test("a pending exploration summary blocks deletion of its parent lesson", async () => {
	const { parent, child } = lesson();
	stores.chatStore.saveMessages(child.id, [newUserMessage("a".repeat(100_000)), newUserMessage("b".repeat(100_000)), newUserMessage("recent")]);
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((done) => { release = done; });
	const started = new Promise<void>((done) => { entered = done; });
	const run = ensureCompacted({
		chatStore: stores.chatStore, engine: {} as never, modelId: "faux:test", kind: "teach", thresholdTokens: 30_000, systemPromptTokens: 0,
		summarize: async () => {
			entered();
			await gate;
			return { summary: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		},
	}, child.id);
	await started;
	try {
		const result = await deleteChatSession(parent.id, "preserve-graph");
		assert.ok(!result.ok && result.status === 409);
		assert.match(result.error, /compacting/);
		assert.ok(stores.chatStore.getChat(parent.id));
		assert.ok(stores.chatStore.getChat(child.id));
	} finally { release(); await run; }
});
