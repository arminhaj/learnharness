import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { demoRetryResponse, retryDemoJob, type DemoRetryDeps } from "../src/server/demo-retry.ts";
import { latestJobAttempt } from "../src/core/contracts/jobs.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-demo-retry-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { stores } = await import("../src/server/stores.ts");
const input = { title: "Waveform timing", brief: "Compare sine and cosine; use i² = −1." };
const question: Extract<LhMessage, { role: "assistant" }> = {
	id: "pending", role: "assistant", content: [{ type: "toolCall", id: "question", name: "explain", arguments: { question: "Which leads?" } }],
	api: "openai-completions", provider: "faux", model: "faux", timestamp: 1, stopReason: "toolUse",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const chats: string[] = [];
function fixture() {
	const chat = stores.chatStore.createChat("Retry fixture"); chats.push(chat.id);
	stores.chatStore.saveMessages(chat.id, [question]);
	const source = stores.jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "demo", input });
	const job = stores.jobStore.updateJob(source.id, {
		status: "error", error: "Bridge failed", activity: "failed", result: { title: input.title, html: "", tested: true },
		delivery: { kind: "result", status: "pending" },
	})!;
	const spawned: string[] = [], superseded: string[] = [];
	const deps: DemoRetryDeps = {
		...stores, isTurnRunning: () => false, canSupersedeJobDelivery: () => true,
		supersedeJobDelivery: id => { superseded.push(id); stores.jobStore.updateJob(id, { delivery: { kind: "result", status: "superseded" } }); },
		spawn: id => { spawned.push(id); assert.deepEqual(stores.jobStore.getJob(id)!.input, input); },
	};
	return { chat, job, deps, spawned, superseded };
}
afterEach(() => { for (const id of chats.splice(0)) { stores.jobStore.deleteJobsForChat(id); stores.chatStore.deleteChat(id); } });
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("retry saves the original Unicode brief before spawning without changing the unanswered question or history", () => {
	const { chat, job, deps, spawned, superseded } = fixture();
	const before = stores.chatStore.getChat(chat.id);
	const outcome = retryDemoJob(deps, job.id, chat.id);
	assert.equal(outcome.status, 202); assert("job" in outcome);
	assert.equal(outcome.job.retryOf, job.id); assert.equal(outcome.job.toolCallId, job.toolCallId);
	assert.equal(outcome.job.status, "running"); assert.equal(outcome.job.result, undefined); assert.equal(outcome.job.error, undefined);
	assert.deepEqual(spawned, [outcome.job.id]); assert.deepEqual(superseded, [job.id]);
	assert.deepEqual(stores.chatStore.getChat(chat.id), before);
	assert.deepEqual(stores.jobStore.getJob(job.id), { ...job, updatedAt: stores.jobStore.getJob(job.id)!.updatedAt, delivery: { kind: "result", status: "superseded" } });
});

test("concurrent POSTs and stale clicks share one attempt even after it finishes or fails", async () => {
	const { chat, job, deps, spawned } = fixture();
	const request = () => new Request("http://localhost/api/jobs/retry", { method: "POST", body: JSON.stringify({ chatId: chat.id }) });
	const responses = await Promise.all(Array.from({ length: 8 }, () => demoRetryResponse(request(), job.id, deps)));
	assert.deepEqual(responses.map(res => res.status), [202, ...Array(7).fill(200)]);
	const ids = await Promise.all(responses.map(async res => (await res.json()).job.id));
	assert.equal(new Set(ids).size, 1); assert.equal(spawned.length, 1);
	for (const status of ["done", "error"] as const) {
		stores.jobStore.updateJob(ids[0], { status });
		const duplicate = retryDemoJob(deps, job.id, chat.id);
		assert.equal(duplicate.status, 200); assert("job" in duplicate); assert.equal(duplicate.job.id, ids[0]);
	}
	assert.equal(spawned.length, 1);
	const again = retryDemoJob(deps, ids[0], chat.id);
	assert.equal(again.status, 202); assert("job" in again); assert.equal(again.job.retryOf, ids[0]); assert.equal(spawned.length, 2);
});

test("late original acknowledgment and same-millisecond retry never replace the latest attempt", () => {
	const { chat, job, deps } = fixture();
	const outcome = retryDemoJob(deps, job.id, chat.id); assert("job" in outcome);
	stores.jobStore.updateJob(job.id, { updatedAt: "2099-01-01T00:00:00Z" });
	assert.equal(stores.jobStore.findJobByToolCallId(chat.id, job.toolCallId)!.id, outcome.job.id);
	const sameTime = { ...outcome.job, createdAt: job.createdAt };
	assert.equal(latestJobAttempt([sameTime, job], job.toolCallId)!.id, sameTime.id);
	assert.equal(latestJobAttempt([job, { ...sameTime, createdAt: "2000-01-01T00:00:00Z" }], job.toolCallId)!.id, sameTime.id);
});

test("legacy failure recovers its exact demo arguments from saved history", () => {
	const { chat, job, deps } = fixture();
	stores.jobStore.updateJob(job.id, { input: undefined });
	stores.chatStore.saveMessages(chat.id, [{ ...question, id: "dispatch", content: [{ type: "toolCall", name: "demo", id: "demo", arguments: input }] }, question]);
	assert.equal(retryDemoJob(deps, job.id, chat.id).status, 202);
});

test("missing, compacted or malformed original brief refuses without spawning", () => {
	for (const saved of [undefined, {}, { title: "Demo", brief: " " }, { title: 3, brief: "brief" }]) {
		const { chat, job, deps, spawned, superseded } = fixture();
		stores.jobStore.updateJob(job.id, { input: saved });
		const before = stores.jobStore.getJob(job.id);
		const outcome = retryDemoJob(deps, job.id, chat.id);
		assert.equal(outcome.status, 409); assert("error" in outcome); assert.match(outcome.error, /original demo brief/);
		assert.deepEqual(spawned, []); assert.deepEqual(superseded, []); assert.deepEqual(stores.jobStore.getJob(job.id), before);
	}
});

test("running teacher or in-flight delivery refuses; an unanswered question alone permits retry", () => {
	for (const gate of ["turn", "delivery"] as const) {
		const { chat, job, deps, spawned } = fixture();
		deps.isTurnRunning = () => gate === "turn"; deps.canSupersedeJobDelivery = () => gate !== "delivery";
		assert.equal(retryDemoJob(deps, job.id, chat.id).status, 409); assert.deepEqual(spawned, []);
	}
});

test("only failed demos belonging to an existing requested lesson can retry", () => {
	const { chat, job, deps, spawned } = fixture();
	assert.equal(retryDemoJob(deps, job.id, "other").status, 404);
	assert.equal(retryDemoJob(deps, "missing", chat.id).status, 404);
	for (const status of ["running", "done"] as const) {
		stores.jobStore.updateJob(job.id, { status }); assert.equal(retryDemoJob(deps, job.id, chat.id).status, 409);
	}
	const other = stores.jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "visual" });
	stores.jobStore.updateJob(other.id, { status: "error" }); assert.equal(retryDemoJob(deps, other.id, chat.id).status, 409);
	stores.chatStore.deleteChat(chat.id); stores.jobStore.updateJob(job.id, { status: "error" });
	assert.equal(retryDemoJob(deps, job.id, chat.id).status, 404); assert.deepEqual(spawned, []);
});

test("HTTP boundary validates job, JSON and chat identifiers before admission", async () => {
	const { chat, job, deps, spawned } = fixture();
	for (const [id, body] of [["../job", { chatId: chat.id }], [job.id, null], [job.id, {}], [job.id, { chatId: "../chat" }], [job.id, { chatId: 1 }]] as const) {
		assert.equal((await demoRetryResponse(new Request("http://localhost", { method: "POST", body: JSON.stringify(body) }), id, deps)).status, 400);
	}
	assert.equal((await demoRetryResponse(new Request("http://localhost", { method: "POST", body: "broken" }), job.id, deps)).status, 400);
	assert.deepEqual(spawned, []);
});
