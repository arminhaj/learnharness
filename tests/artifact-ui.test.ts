/**
 * THE ARTIFACT-UI ROUTE (owner, 2026-10-07): POST /api/chats/:id/artifact-ui
 * persists the learner's invert switch onto a demo/figure steer message
 * (details.ui.inverted) — the silent record-write route (no wake, no SSE).
 * The pure core (setSteerUiInverted) is pinned in tests/demos.test.tsx;
 * this file pins the ROUTE contract: 404 unknown chat, 400 for a bad body
 * or a non-artifact message id, and the record actually carrying the flag
 * after a write.
 *
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline:
 * the seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { JobRecord } from "../src/core/contracts/jobs.ts";
import type { LhViewMessage } from "../src/core/view.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-artifact-ui-"));
process.env.LH_DATA_DIR = TMP_DATA;

type Post = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: Post;
let createChat: (title: string, kind?: "practice") => { id: string; title: string };
let saveMessages: (id: string, messages: unknown[]) => void;
let getChat: (id: string) => { messages: unknown[] } | undefined;
let buildSubagentSteerFn: typeof import("../src/core/contracts.ts").buildSubagentSteer;
let jobStore: typeof import("../src/store/jobs.ts").jobStore;
let renderArtifact: (message: LhViewMessage, jobs: JobRecord[]) => string;

before(async () => {
	const route = await import("../app/api/chats/[id]/artifact-ui/route.ts");
	POST = route.POST;
	const server = await import("../src/server/chats.ts");
	createChat = server.createChat;
	getChat = server.getChat as typeof getChat;
	const { chatStore } = await import("../src/store/chats.ts");
	saveMessages = (id, messages) => chatStore.saveMessages(id, messages as never);
	const contracts = await import("../src/core/contracts.ts");
	buildSubagentSteerFn = contracts.buildSubagentSteer;
	jobStore = (await import("../src/store/jobs.ts")).jobStore;
	const React = (await import("react")).default;
	(globalThis as Record<string, unknown>).React = React;
	const { renderToStaticMarkup } = await import("react-dom/server");
	const { JobsContext } = await import("../components/jobs-context.ts");
	const { SubagentSteerCard } = await import("../components/artifacts/steer-card.tsx");
	renderArtifact = (message, jobs) => renderToStaticMarkup(React.createElement(JobsContext.Provider, { value: jobs },
		React.createElement(SubagentSteerCard, { message })));
});

const post = (id: string, body: unknown) =>
	POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), {
		params: Promise.resolve({ id }),
	});

describe("POST /api/chats/:id/artifact-ui", () => {
	it("404s an unknown chat", async () => {
		const res = await post("nope", { input: { messageId: "x", inverted: true } });
		assert.equal(res.status, 404);
	});

	it("400s a malformed body and a non-artifact message id", async () => {
		const chat = createChat("Artifact UI guards");
		const steer = buildSubagentSteerFn(
			{ id: "jg", kind: "demo", toolCallId: "cg" },
			{ title: "T", html: "<p>x</p>", tested: true },
		);
		saveMessages(chat.id, [
			{ id: "m1", role: "user", content: "hi" },
			steer as never,
		]);
		assert.equal((await post(chat.id, { input: { messageId: "m1", inverted: true } })).status, 400);
		assert.equal((await post(chat.id, { input: { messageId: "missing", inverted: true } })).status, 400);
		assert.equal((await post(chat.id, {})).status, 400);
		assert.equal((await post(chat.id, { input: { messageId: "m1", inverted: "yes" } })).status, 400);
	});

	it("persists ui.inverted onto the demo steer and toggles it back", async () => {
		const chat = createChat("Artifact UI round trip");
		const steer = buildSubagentSteerFn(
			{ id: "jk", kind: "visual", toolCallId: "ck" },
			{ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>' },
		);
		saveMessages(chat.id, [steer as never]);

		assert.equal((await post(chat.id, { input: { messageId: steer.id, inverted: true } })).status, 200);
		let saved = getChat(chat.id)!.messages as [{ details: { ui?: { inverted?: boolean } } }];
		assert.equal(saved[0]!.details.ui?.inverted, true, "the flag rides the record");

		assert.equal((await post(chat.id, { input: { messageId: steer.id, inverted: false } })).status, 200);
		saved = getChat(chat.id)!.messages as [{ details: { ui?: { inverted?: boolean } } }];
		assert.equal(saved[0]!.details.ui?.inverted, false, "and toggles back off");
	});

	it("persists a completed figure's preference before delivery without adding a transcript marker or waking the tutor", async () => {
		const chat = createChat("Figure before tutor delivery");
		const job = jobStore.createJob({ chatId: chat.id, kind: "visual", toolCallId: "figure_call" });
		const result = { svg: "<svg/>" };
		jobStore.updateJob(job.id, { status: "done", result, delivery: { kind: "result", status: "pending" } });
		const messages = structuredClone(getChat(chat.id)!.messages);
		assert.equal((await post(chat.id, { input: { messageId: `steer_${job.id}`, inverted: true } })).status, 200);
		const saved = jobStore.getJob(job.id)!;
		assert.deepEqual(saved.ui, { inverted: true });
		assert.deepEqual(saved.delivery, { kind: "result", status: "pending" });
		assert.deepEqual(getChat(chat.id)!.messages, messages, "display preferences do not deliver the model-facing marker");
		// Once delivered, the saved marker takes precedence over the job preference.
		const steer = buildSubagentSteerFn(saved, result);
		saveMessages(chat.id, [steer]);
		assert.equal((await post(chat.id, { input: { messageId: steer.id, inverted: false } })).status, 200);
		assert.equal((getChat(chat.id)!.messages[0] as { details: { ui: { inverted: boolean } } }).details.ui.inverted, false);
	});

	it("rejects preview preferences for another chat, an unfinished job, an abort or a non-figure", async () => {
		const chat = createChat("Preview guards");
		const other = createChat("Other chat");
		const job = jobStore.createJob({ chatId: chat.id, kind: "visual", toolCallId: "figure_call" });
		const input = { messageId: `steer_${job.id}`, inverted: true };
		assert.equal((await post(chat.id, { input })).status, 400);
		jobStore.updateJob(job.id, { status: "done", result: { svg: "<svg/>" }, delivery: { kind: "result", status: "pending" } });
		assert.equal((await post(other.id, { input })).status, 400);
		jobStore.updateJob(job.id, { delivery: { kind: "abort", status: "pending" } });
		assert.equal((await post(chat.id, { input })).status, 400);
		const demo = jobStore.createJob({ chatId: chat.id, kind: "demo", toolCallId: "demo_call" });
		jobStore.updateJob(demo.id, { status: "done", result: { svg: "<svg/>" }, delivery: { kind: "result", status: "pending" } });
		assert.equal((await post(chat.id, { input: { ...input, messageId: `steer_${demo.id}` } })).status, 400);
	});

	it("persists pending verified demo preferences without altering its question, result or delivery", async () => {
		const chat = createChat("Verified demo before tutor delivery");
		saveMessages(chat.id, [{ id: "pending", role: "assistant", content: [{ type: "toolCall", id: "question", name: "explain", arguments: { question: "Which signal leads?" } }] }]);
		const job = jobStore.createJob({ chatId: chat.id, kind: "demo", toolCallId: "demo_call" });
		const result = { title: "Waveform timing", html: "<!doctype html><button>+90°</button>", tested: true as const };
		jobStore.updateJob(job.id, { status: "done", result, delivery: { kind: "result", status: "pending" } });
		const messages = structuredClone(getChat(chat.id)!.messages);
		for (const inverted of [true, false]) {
			assert.equal((await post(chat.id, { input: { messageId: `steer_${job.id}`, inverted } })).status, 200);
			const saved = jobStore.getJob(job.id)!;
			assert.deepEqual(saved.ui, { inverted });
			assert.deepEqual(saved.result, result);
			assert.equal(saved.status, "done");
			assert.deepEqual(saved.delivery, { kind: "result", status: "pending" });
			assert.deepEqual(getChat(chat.id)!.messages, messages, "the pending question and transcript stay unchanged");
		}

		// Once canonical delivery exists, its preference wins over stale job UI.
		const canonical = buildSubagentSteerFn(jobStore.getJob(job.id)!, result);
		saveMessages(chat.id, [...messages, canonical]);
		for (const inverted of [true, false]) {
			assert.equal((await post(chat.id, { input: { messageId: canonical.id, inverted } })).status, 200);
			const saved = getChat(chat.id)!.messages;
			assert.deepEqual(saved.slice(0, messages.length), messages);
			assert.equal((saved.at(-1) as { details: { ui: { inverted: boolean } } }).details.ui.inverted, inverted);
			assert.deepEqual(jobStore.getJob(job.id)!.ui, { inverted: false }, "canonical writes do not overwrite job preferences");
		}
	});

	it("rejects incomplete, unverified, empty, legacy, aborted and wrong-chat demo preview preferences", async () => {
		const chat = createChat("Verified demo preview guards");
		const other = createChat("Other demo chat");
		const job = jobStore.createJob({ chatId: chat.id, kind: "demo", toolCallId: "demo_call" });
		const input = { messageId: `steer_${job.id}`, inverted: true };
		const result = { title: "Demo", html: "<html/>", tested: true as const };
		const messages = structuredClone(getChat(chat.id)!.messages);
		assert.equal((await post(chat.id, { input })).status, 400, "unfinished job");
		for (const invalid of [
			null, {}, { svg: "<svg/>" }, { ...result, tested: false }, { title: "Demo", html: "<html/>" },
			{ ...result, tested: "true" }, { ...result, html: "" }, { ...result, html: " \n " },
			{ ...result, title: "" }, { ...result, title: "   " }, { html: "<html/>", tested: true },
		]) {
			jobStore.updateJob(job.id, { status: "done", result: invalid as never, delivery: { kind: "result", status: "pending" } });
			assert.equal((await post(chat.id, { input })).status, 400, JSON.stringify(invalid));
			assert.equal(jobStore.getJob(job.id)!.ui, undefined);
		}
		jobStore.updateJob(job.id, { status: "done", result, delivery: { kind: "result", status: "pending" } });
		assert.equal((await post(other.id, { input })).status, 400, "other chat");
		jobStore.updateJob(job.id, { delivery: undefined });
		assert.equal((await post(chat.id, { input })).status, 400, "legacy job has no delivery metadata");
		jobStore.updateJob(job.id, { delivery: { kind: "abort", status: "pending" } });
		assert.equal((await post(chat.id, { input })).status, 400, "abort delivery");
		jobStore.updateJob(job.id, { status: "error", delivery: { kind: "result", status: "pending" } });
		assert.equal((await post(chat.id, { input })).status, 400, "failed job");
		assert.deepEqual(getChat(chat.id)!.messages, messages);
	});

	it("uses a saved pending-demo preference on mount and gives canonical UI preferences precedence", async () => {
		const chat = createChat("Demo preference rendering");
		const job = jobStore.createJob({ chatId: chat.id, kind: "demo", toolCallId: "demo_call" });
		const result = { title: "Waveform timing", html: "<p>Timing</p>", tested: true as const };
		jobStore.updateJob(job.id, { status: "done", result, delivery: { kind: "result", status: "pending" } });
		const message: LhViewMessage = { id: `steer_${job.id}`, role: "user", parts: [
			{ type: "data-subagent-artifact", data: { kind: "demo", result } },
		] };
		assert.equal((await post(chat.id, { input: { messageId: message.id, inverted: true } })).status, 200);
		const savedJob = jobStore.getJob(job.id)!;
		assert.match(renderArtifact(message, [savedJob]), /filter:invert\(1\) hue-rotate\(180deg\)/);
		const canonical: LhViewMessage = { ...message, parts: [
			{ type: "data-subagent-artifact", data: { kind: "demo", result, ui: { inverted: false } } },
		] };
		assert.doesNotMatch(renderArtifact(canonical, [savedJob]), /filter:invert/,
			"explicit canonical false overrides saved job true");
		assert.equal((await post(chat.id, { input: { messageId: message.id, inverted: false } })).status, 200);
		assert.doesNotMatch(renderArtifact(message, [jobStore.getJob(job.id)!]), /filter:invert/);
	});
});

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
