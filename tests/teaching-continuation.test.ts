import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-teaching-continuation-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createTeacherAgent, createExplorationAgent } = await import("../src/agent/teacher-agent.ts");
const { teachingPauseTool } = await import("../src/agent/tools/teaching-pause.ts");
const { needsContinuation, newAnswerResult, newUserMessage } = await import("../src/core/native-messages.ts");
const { teachingPausedByLearner } = await import("../src/core/teaching-flow.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const question = {
	type: "check", nodeId: "equation", question: "What is the acceleration?",
	options: [{ label: "0.3" }, { label: "0.15" }], correctAnswer: "0.3", explanation: "Keep both length factors.",
};
const feedback = "Your sign reasoning is correct. The missing factor gives an acceleration of 0.3.";
const text = (value: string) => fauxAssistantMessage([fauxText(value)]);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id = name) => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

function setup(steps: FauxResponseStep[], options: { completed?: boolean; noPlan?: boolean; exploration?: boolean; freeRecall?: boolean } = {}) {
	const chat = chatStore.createChat("Swing feedback regression");
	if (!options.noPlan) chatStore.saveTree(chat.id, { nodes: [{ id: "equation", title: "Equation of motion" }, { id: "linear", title: "Linearization" }], edges: [{ from: "equation", to: "linear" }], version: 1 });
	if (options.completed !== undefined) chatStore.setLessonCompleted(chat.id, options.completed);
	const ctx = { chatId: chat.id, chatStore, jobStore, spawn: () => {} };
	const faux = createFauxCore({});
	faux.setResponses(steps);
	const answer = newAnswerResult("previous-check", "quiz", { kind: "quiz", questionText: question.question, dontKnow: false, answers: [], answeredAt: new Date().toISOString(), text: "0.15, increasing" });
	const messages = [newUserMessage("Teach the swing"), { ...call("quiz", question, "previous-check"), id: "old-question" }, answer] as AgentMessage[];
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const agent = (options.exploration ? createExplorationAgent : createTeacherAgent)(ctx, { engine, messages, ...(options.freeRecall ? { teachingProfile: "mad-max" as const } : {}) });
	return { agent, ctx, chat, messages, engine };
}

test("saved learner answer → visible feedback → automatic next question, without synthetic learner input", async () => {
	let calls = 0;
	const { agent, messages } = setup([
		() => { calls++; return text(feedback); },
		context => {
			calls++;
			assert.ok(context.messages.some(m => m.role === "assistant" && JSON.stringify(m.content).includes(feedback)));
			assert.ok(context.messages.some(m => m.role === "system" && JSON.stringify(m.content).includes("Your feedback has already been shown")));
			return call("quiz", question, "next-check");
		},
	]);
	const visible: string[] = [];
	agent.subscribe(e => { if (e.type === "message_end" && e.message.role === "assistant") visible.push(JSON.stringify(e.message.content)); });
	await agent.continue();
	assert.equal(calls, 2);
	assert.match(visible[0]!, /missing factor/);
	assert.match(visible[1]!, /next-check/);
	assert.equal(agent.state.messages.filter(m => m.role === "user").length, 1);
	assert.deepEqual(agent.state.messages.filter(m => m.role !== "system").slice(0, messages.length), messages);
	assert.equal(agent.state.messages.some(m => m.role === "system" && JSON.stringify(m).includes("Your feedback has already been shown")), false);
});

test("learner questions and exploration questions stop immediately after recovery", async () => {
	for (const exploration of [false, true]) {
		const { agent } = setup([text(feedback), call("ask_user_question", { question: "Show the constant-length equation." }, "next-activity")], { exploration });
		await agent.continue();
		assert.equal(agent.state.messages.filter(m => m.role === "assistant").length, 3);
		assert.equal(agent.state.errorMessage, undefined);
	}
});

test("Mad Max free-recall checks recover feedback and then wait for the learner", async () => {
	const { agent } = setup([text(feedback), call("explain", {
		type: "check", nodeId: "equation", question: question.question, correctAnswer: "0.3",
		choiceHints: [{ label: "0.3" }, { label: "0.15" }],
	}, "recall-check")], { freeRecall: true });
	await agent.continue();
	assert.equal(agent.state.errorMessage, undefined);
	assert.equal(agent.state.messages.filter(m => m.role === "assistant").length, 3);
	assert.match(JSON.stringify(agent.state.messages.at(-1)), /Question posed/);
});

test("one answer POST streams and saves feedback plus the next question", async () => {
	const { handleChatRequest } = await import("../src/server/chat-handler.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	const { danglingQuestionOf } = await import("../src/core/native-messages.ts");
	const { chat, ctx, engine, messages } = setup([text(feedback), call("quiz", question, "next-post-check")]);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(chat.id, messages.slice(0, -1) as Parameters<typeof chatStore.saveMessages>[1]);
	const answer = (messages.at(-1) as { details: unknown }).details;
	const response = await handleChatRequest(new Request("http://test/api/chat", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId: chat.id, input: { type: "answer", toolCallId: "previous-check", answer } }),
	}), opts => createTeacherAgent(ctx, { ...opts, engine }));
	assert.equal(response.status, 200);
	const turn = runningTurn(chat.id);
	assert.ok(turn);
	const events = await new Response(turn.subscribe()).text();
	assert.match(events, /missing factor/);
	assert.match(events, /next-post-check/);
	const saved = chatStore.getChat(chat.id)!;
	assert.equal(danglingQuestionOf(saved.messages)?.toolCallId, "next-post-check");
	assert.equal(saved.messages.filter(m => m.role === "user").length, 1);
	assert.equal(saved.messages.filter(m => m.role === "toolResult" && m.toolCallId === "previous-check").length, 1);
});

test("completion recorded during the turn permits a closing response", async () => {
	const { agent, ctx } = setup([
		call("plan_set_completed", { nodeId: "equation", completed: true, reason: "Learner derived the equation." }),
		call("plan_set_completed", { nodeId: "linear", completed: true, reason: "Learner independently linearized it." }),
		text("The lesson is complete."),
	]);
	await agent.continue();
	assert.equal(agent.state.errorMessage, undefined);
	assert.deepEqual(chatStore.getChat(ctx.chatId)!.tree!.completedNodeIds, ["equation", "linear"]);
});

test("completed and pre-plan sessions do not recover ordinary text stops", async () => {
	for (const opts of [{ completed: true }, { noPlan: true }]) {
		const { agent } = setup([text("Done.")], opts);
		await agent.continue();
		assert.equal(agent.state.errorMessage, undefined);
		assert.equal(agent.state.messages.filter(m => m.role === "assistant").length, 2);
	}
});

test("explicit learner pause survives mixed tool batches and reload without phantom continuation", async () => {
	const pause = { reason: "learner_request", explanation: "The learner asked to stop for today." };
	const { agent, ctx } = setup([fauxAssistantMessage([
		fauxText("Paused here as requested."),
		fauxToolCall("pause_teaching", pause, { id: "pause" }),
		fauxToolCall("plan_set_completed", { nodeId: "equation", completed: true, reason: "The derivation was demonstrated." }, { id: "mark-step" }),
	], { stopReason: "toolUse" })]);
	await agent.continue();
	const saved = agent.state.messages as Parameters<typeof chatStore.saveMessages>[1];
	chatStore.saveMessages(ctx.chatId, saved);
	const reloaded = chatStore.getChat(ctx.chatId)!.messages;
	assert.equal(needsContinuation(reloaded), false);
	assert.equal(teachingPausedByLearner(reloaded), true);
	assert.equal(teachingPausedByLearner([...reloaded, newUserMessage("Resume")]), false);
	assert.equal(chatStore.getChat(ctx.chatId)!.lessonCompleted, undefined);
});

test("job waits require a running job in this lesson and remain eligible for delivery", async () => {
	const { agent, ctx } = setup([]);
	const job = jobStore.createJob({ chatId: ctx.chatId, kind: "research", toolCallId: "research" });
	const tool = teachingPauseTool(ctx);
	const input = { reason: "waiting_for_job" as const, explanation: "Need the source before assessing.", jobId: job.id };
	const result = await tool.execute("wait", input);
	assert.equal(result.terminate, true);
	const waitMessage = { role: "toolResult", toolName: "pause_teaching", toolCallId: "wait", ...result, timestamp: 1 };
	assert.equal(teachingPausedByLearner([waitMessage]), false);
	const transcript = [{ ...call("pause_teaching", input, "wait"), id: "wait-call" }, { ...waitMessage, id: "wait-result" }] as Parameters<typeof needsContinuation>[0];
	assert.equal(needsContinuation(transcript), false);
	jobStore.updateJob(job.id, { status: "done" });
	assert.equal((await tool.execute("late-wait", input)).isError, true);
	assert.equal((await tool.execute("missing-wait", { ...input, jobId: "missing" })).isError, true);
	assert.equal(agent.state.isStreaming, false);
});

test("repeated text-only stops surface a retryable error instead of looping or silently stopping", async () => {
	const { agent } = setup([text(feedback), text("Let us continue."), text("Next we will linearize.")]);
	await agent.continue();
	assert.match(agent.state.errorMessage ?? "", /next teaching activity after automatic retries/);
	assert.equal(agent.state.messages.at(-1)?.role, "assistant");
	assert.equal((agent.state.messages.at(-1) as { stopReason: string }).stopReason, "error");
});

test("provider errors and aborts never trigger another request", async () => {
	for (const stopReason of ["error", "aborted"] as const) {
		const { agent } = setup([fauxAssistantMessage([fauxText("Interrupted")], { stopReason })]);
		await agent.continue();
		assert.equal(agent.state.messages.filter(m => m.role === "assistant").length, 2);
		assert.equal((agent.state.messages.at(-1) as { stopReason: string }).stopReason, stopReason);
	}
});
