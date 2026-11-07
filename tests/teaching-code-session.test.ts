import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import { pendingQuestionOf, type LhMessage, type QuestionAnswerData } from "../src/core/index.ts";

const question = {
	id: "teaching-q", role: "assistant", content: [{ type: "toolCall", id: "coding-ask", name: "ask_user_question", arguments: {
		question: "Implement a sliding window.", codeExercise: { language: "cpp", starterCode: "int main() {}", tests: [{ name: "empty", stdin: "", expectedStdout: "" }] },
	} }], stopReason: "toolUse", timestamp: 1,
} as unknown as LhMessage;
const answer: QuestionAnswerData = { kind: "ask", questionText: "Implement a sliding window.", answers: [], options: [], dontKnow: false,
	answeredAt: "2026-10-30T12:00:00Z", text: "Code answer submitted for review.", thinking: "Maintain a valid interval." };

test("Teaching code answer passes the stored check id on the answer event and awaits acceptance", async () => {
	const posts: { input: { codeRunId?: string; type: string; answer: QuestionAnswerData } }[] = [];
	const model = new SessionModel({ chatId: "teaching", initialMessages: [question], fetch: async (url, init) => {
		if (String(url) === "/api/chat") { posts.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
		if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n");
		return Response.json({ messages: [question] });
	} });
	await model.submitAnswer("ask_user_question", "coding-ask", answer, pendingQuestionOf([question])!.key, "run-teaching");
	assert.equal(posts.length, 1);
	assert.equal(posts[0]?.input.type, "answer");
	assert.equal(posts[0]?.input.codeRunId, "run-teaching");
	assert.equal(posts[0]?.input.answer.thinking, answer.thinking);
	assert.equal(posts[0]?.input.answer.codeResult, undefined);
});

test("Teaching code answer rejects 422 and retains the pending question and reasoning draft", async () => {
	const model = new SessionModel({ chatId: "teaching", initialMessages: [question], fetch: async () => Response.json({ error: "Check the changed source again." }, { status: 422 }) });
	const key = pendingQuestionOf([question])!.key;
	model.saveQuestionDraft(key, { readingThinking: "I need to preserve this." });
	await assert.rejects(model.submitAnswer("ask_user_question", "coding-ask", answer, key, "stale-run"), /Check the changed source again/);
	assert.equal(pendingQuestionOf(model.getState().nativeMessages)?.toolCallId, "coding-ask");
	assert.equal(model.questionDraft(key)?.readingThinking, "I need to preserve this.");
	assert.equal(model.getState().error?.message, "Check the changed source again.");
});

test("Teaching code answer rejects an outdated question occurrence before making a request", async () => {
	let requests = 0;
	const model = new SessionModel({ chatId: "teaching", initialMessages: [question], fetch: async () => { requests++; return Response.json({ ok: true }); } });
	await assert.rejects(model.submitAnswer("ask_user_question", "coding-ask", answer, "old-question-key", "run-teaching"), /not accepted/);
	assert.equal(requests, 0);
});
