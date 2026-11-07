import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withCompletedVisuals } from "../components/artifacts/completed-visuals.ts";
import type { JobRecord } from "../src/core/contracts/jobs.ts";
import type { LhViewMessage } from "../src/core/view.ts";

const messages: LhViewMessage[] = [{
	id: "teaching", role: "assistant", parts: [
		{ type: "tool-visual", toolCallId: "figure", state: "output-available", output: "Dispatched" },
		{ type: "tool-explain", toolCallId: "question", state: "input-available", input: { question: "What do you notice?" } },
	],
}];
const job: JobRecord = {
	id: "job_figure", chatId: "lesson", kind: "visual", toolCallId: "figure", status: "done", activity: "finished",
	createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:01:00Z",
	delivery: { kind: "result", status: "pending" }, result: { svg: "<svg/>" }, ui: { inverted: true },
};

describe("completed figures independent of teacher delivery", () => {
	it("recovers a saved pending figure on mount without changing the question, ack or delivery status", () => {
		const before = structuredClone({ messages, job });
		const view = withCompletedVisuals(messages, [job], "lesson");
		assert.equal(view.length, 2);
		assert.equal(view[0], messages[0]);
		assert.equal(view[1]!.id, "steer_job_figure");
		assert.deepEqual(view[1]!.parts, [{ type: "data-subagent-artifact", id: "sa_steer_job_figure", data: { kind: "visual", result: job.result, ui: job.ui } }]);
		assert.deepEqual({ messages, job }, before);
	});

	it("keeps a figure during job/history arrival races and lets the canonical marker win even against a stale job feed", () => {
		const delivered: JobRecord = { ...job, delivery: { kind: "result", status: "delivered" } };
		const view = withCompletedVisuals(messages, [delivered], "lesson");
		assert.equal(view.length, 2, "job delivery alone must not hide the image");
		const saved: LhViewMessage[] = [...messages, { ...view[1]!, parts: [{ type: "data-subagent-artifact", data: { kind: "visual", result: job.result, ui: { inverted: false } } }] }];
		assert.equal(withCompletedVisuals(saved, [job], "lesson"), saved, "the saved marker is authoritative");
		assert.equal(withCompletedVisuals([], [delivered], "lesson").length, 0, "compacted delivered figures stay in history");
	});

	it("does not expose incomplete, failed, aborted, legacy, other-chat or other-kind jobs", () => {
		for (const patch of [
			{ status: "running" }, { status: "error" }, { result: { svg: "" } }, { result: null },
			{ delivery: { kind: "abort", status: "pending" } }, { delivery: undefined },
			{ kind: "demo" }, { chatId: "other" },
		] satisfies Partial<JobRecord>[]) {
			assert.equal(withCompletedVisuals(messages, [{ ...job, ...patch }], "lesson"), messages, JSON.stringify(patch));
		}
	});

	it("orders multiple completed figures by dispatch time and deduplicates repeated feed entries", () => {
		const later = { ...job, id: "job_later", createdAt: "2026-11-02T00:02:00Z" };
		const view = withCompletedVisuals(messages, [later, { ...job, updatedAt: "2026-11-02T00:03:00Z" }, job], "lesson");
		assert.deepEqual(view.slice(1).map(message => message.id), ["steer_job_figure", "steer_job_later"]);
	});
});

const demoMessages: LhViewMessage[] = [{
	id: "demo-teaching", role: "assistant", parts: [
		{ type: "tool-demo", toolCallId: "demo", state: "output-available", output: "Dispatched" },
		{ type: "tool-explain", toolCallId: "pending-question", state: "input-available", input: { question: "Which signal leads?" } },
	],
}];
const demoJob: JobRecord = {
	...job, id: "job_demo", kind: "demo", toolCallId: "demo", createdAt: "2026-11-02T00:01:00Z",
	result: { title: "Waveform timing", html: "<!doctype html><button>Phase +90°</button>", tested: true },
};

describe("verified completed demos independent of teacher delivery", () => {
	it("replaces a saved failure with its retry while preserving transcript and pending question", () => {
		const failed: JobRecord = { ...demoJob, status: "error", delivery: { kind: "result", status: "delivered" }, result: { title: "Failed", html: "", tested: true } };
		const marker: LhViewMessage = { id: `steer_${failed.id}`, role: "user", parts: [{ type: "data-subagent-artifact", data: { kind: "demo", result: failed.result } }] };
		const saved = [...demoMessages, marker];
		const retry: JobRecord = { ...demoJob, id: "job_retry", retryOf: failed.id, createdAt: "2026-11-02T00:02:00Z", status: "running", result: undefined, delivery: undefined };
		const before = structuredClone({ saved, failed, retry });
		assert.deepEqual(withCompletedVisuals(saved, [failed, retry], "lesson"), demoMessages);
		const view = withCompletedVisuals(saved, [failed, { ...retry, status: "done", result: demoJob.result, delivery: { kind: "result", status: "pending" } }], "lesson");
		assert.deepEqual(view.map(message => message.id), [demoMessages[0]!.id, "steer_job_retry"]);
		assert.deepEqual({ saved, failed, retry }, before);
	});

	it("never revives a superseded result, including after history compaction", () => {
		const superseded: JobRecord = { ...demoJob, delivery: { kind: "result", status: "superseded" } };
		assert.equal(withCompletedVisuals(demoMessages, [superseded], "lesson"), demoMessages);
		assert.deepEqual(withCompletedVisuals([], [superseded], "lesson"), []);
	});

	it("keeps the next retry reachable after a failed retry with no remaining dispatch call", () => {
		const retry: JobRecord = { ...demoJob, id: "job_retry_failed", retryOf: demoJob.id, status: "error", result: { title: "Retry failed", html: "", tested: true, notes: "Try again" } };
		const questionOnly = [{ ...demoMessages[0]!, parts: [demoMessages[0]!.parts[1]!] }];
		const view = withCompletedVisuals(questionOnly, [retry], "lesson");
		assert.equal(view.length, 2); assert.equal(view[0], questionOnly[0]); assert.equal(view[1]!.id, "steer_job_retry_failed");
		assert.equal(withCompletedVisuals(questionOnly, [{ ...retry, delivery: { kind: "result", status: "delivered" } }], "lesson"), questionOnly,
			"a compacted delivered failure is not revived");
	});

	it("renders a pending verified demo without changing the unanswered question, ack, job or saved messages", () => {
		const before = structuredClone({ messages: demoMessages, job: demoJob });
		const view = withCompletedVisuals(demoMessages, [demoJob], "lesson");
		assert.equal(view.length, 2);
		assert.equal(view[0], demoMessages[0]);
		assert.equal(view[0]!.parts[1], demoMessages[0]!.parts[1]);
		assert.equal(view[1]!.id, "steer_job_demo");
		assert.deepEqual(view[1]!.metadata, { subagentResult: { jobId: "job_demo", kind: "demo", toolCallId: "demo" } });
		assert.deepEqual(view[1]!.parts, [{ type: "data-subagent-artifact", id: "sa_steer_job_demo", data: { kind: "demo", result: demoJob.result, ui: demoJob.ui } }]);
		assert.deepEqual({ messages: demoMessages, job: demoJob }, before);
	});

	it("requires explicit successful verification, HTML, title and result delivery metadata", () => {
		for (const result of [
			null, undefined, {}, { svg: "<svg/>" },
			{ title: "Demo", html: "<html/>", tested: false },
			{ title: "Demo", html: "<html/>" },
			{ title: "Demo", html: "<html/>", tested: "true" },
			{ title: "Demo", html: "", tested: true },
			{ title: "Demo", html: "  \n ", tested: true },
			{ title: "Demo", html: 42, tested: true },
			{ title: "", html: "<html/>", tested: true },
			{ title: "  ", html: "<html/>", tested: true },
			{ html: "<html/>", tested: true },
		]) {
			const candidate = { ...demoJob, result } as JobRecord;
			assert.equal(withCompletedVisuals(demoMessages, [candidate], "lesson"), demoMessages, JSON.stringify(result));
		}
		for (const patch of [
			{ status: "running" }, { status: "error" }, { delivery: undefined },
			{ delivery: { kind: "abort", status: "pending" } }, { chatId: "other" }, { kind: "pdf" },
		] satisfies Partial<JobRecord>[]) {
			assert.equal(withCompletedVisuals(demoMessages, [{ ...demoJob, ...patch }], "lesson"), demoMessages, JSON.stringify(patch));
		}
	});

	it("bridges the delivery/history race and lets the canonical demo marker win", () => {
		const delivered: JobRecord = { ...demoJob, delivery: { kind: "result", status: "delivered" } };
		const view = withCompletedVisuals(demoMessages, [delivered], "lesson");
		assert.equal(view.length, 2);
		const canonical: LhViewMessage = { ...view[1]!, parts: [{ type: "data-subagent-artifact", data: {
			kind: "demo", result: { title: "Canonical demo", html: "<html/>", tested: true }, ui: { inverted: false },
		} }] };
		const saved = [...demoMessages, canonical];
		assert.equal(withCompletedVisuals(saved, [demoJob], "lesson"), saved);
		assert.equal(withCompletedVisuals([], [delivered], "lesson").length, 0, "compacted delivered demos stay in history");
		assert.equal(withCompletedVisuals(messages, [{ ...delivered, toolCallId: "figure" }], "lesson"), messages,
			"an unrelated figure call does not revive a compacted demo");
	});

	it("shows owed pending demos after compaction and deduplicates mixed artifacts by stable id", () => {
		assert.equal(withCompletedVisuals([], [demoJob], "lesson").length, 1, "pending delivery is still owed");
		const base = [...messages, ...demoMessages];
		const later: JobRecord = { ...demoJob, id: "job_demo_later", createdAt: "2026-11-02T00:02:00Z" };
		const view = withCompletedVisuals(base, [later, demoJob, job, demoJob, job], "lesson");
		assert.deepEqual(view.slice(base.length).map(message => message.id), ["steer_job_figure", "steer_job_demo", "steer_job_demo_later"]);
		assert.equal(view[0], messages[0]);
		assert.equal(view[1], demoMessages[0]);
	});
});
