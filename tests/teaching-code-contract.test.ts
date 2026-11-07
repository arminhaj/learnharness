import assert from "node:assert/strict";
import { test } from "node:test";
import { askInputProblems, compactAnswerForModel, type QuestionAnswerData } from "../src/core/question-core.ts";
import { parseAskInput } from "../src/core/tool-parts.ts";
import { parseChatInput, inputAppends } from "../src/core/input-events.ts";
import { CODE_DEMO_EXERCISE, type CodeRunResult } from "../src/core/code-workspace.ts";
import { type LhMessage, danglingQuestionOf } from "../src/core/native-messages.ts";
import { askUserQuestionTool } from "../src/agent/tools.ts";

const question = { question: "Implement the sum function and explain its complexity.", codeExercise: { ...CODE_DEMO_EXERCISE, language: "cpp" as const } };
const result: CodeRunResult = { id: "check-one", workspaceId: "workspace", source: "int main() {}", revision: "saved", language: "cpp", status: "tests_failed", compiler: "clang++", stdout: "", stderr: "", tests: [], createdAt: "2026-10-30T12:00:00Z" };
const answer: QuestionAnswerData = { kind: "ask", questionText: question.question, dontKnow: false, answers: [], text: "submitted source", thinking: "Each input is read once.", answeredAt: "2026-10-30T12:00:00Z" };
function call(args: unknown = question): LhMessage {
    return { id: "message", role: "assistant", content: [{ type: "toolCall", id: "coding-question", name: "ask_user_question", arguments: args }], timestamp: 1, api: "faux", provider: "test", model: "test", stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as LhMessage;
}

test("Teaching coding input remains free response and preserves the executable payload", async () => {
    assert.deepEqual(askInputProblems(question), []);
    assert.deepEqual(parseAskInput(question)?.codeExercise, CODE_DEMO_EXERCISE);
    const posed = await askUserQuestionTool.execute("coding-question", question, undefined, undefined);
    assert.ok(posed);
    const choices = { ...question, options: [{ label: "A" }, { label: "B" }] };
    assert.match(askInputProblems(choices).join(" "), /free-response/);
    assert.equal(parseAskInput(choices), undefined);
    assert.equal(parseAskInput({ ...question, codeExercise: { ...CODE_DEMO_EXERCISE, tests: [] } }), undefined);
    assert.equal(parseAskInput({ ...question, codeExercise: { ...CODE_DEMO_EXERCISE, starterCode: "x".repeat(65537) } }), undefined);
    assert.deepEqual(parseAskInput({ question: "Which topic?" }), { question: "Which topic?" });
});

test("client code verdicts are discarded and opaque check IDs are bounded", () => {
    const parsed = parseChatInput({ type: "answer", toolCallId: "coding-question", codeRunId: "check-one", answer: { ...answer, codeResult: { ...result, status: "passed" } } });
    assert.equal(parsed.type, "answer");
    if (parsed.type !== "answer") return;
    assert.equal(parsed.codeRunId, "check-one");
    assert.equal(parsed.answer.codeResult, undefined);
    assert.throws(() => parseChatInput({ type: "answer", toolCallId: "coding-question", codeRunId: {}, answer }), /valid check ID/);
    assert.throws(() => parseChatInput({ type: "answer", toolCallId: "coding-question", codeRunId: "x".repeat(129), answer }), /valid check ID/);
});

test("checked Teaching answers persist evidence without claiming correctness or switching mode", () => {
    const record = { kind: "teach", messages: [call()] };
    const checked = { ...answer, codeResult: result };
    const input = { type: "answer" as const, toolCallId: "coding-question", answer: checked, codeRunId: result.id };
    const appended = inputAppends(record, input);
    assert.equal(record.kind, "teach");
    assert.equal(appended[0]?.role, "toolResult");
    assert.equal(danglingQuestionOf([...record.messages, ...appended]), null);
    assert.equal(compactAnswerForModel(checked).correct, undefined);
    assert.deepEqual(compactAnswerForModel(checked).codeResult, result);
    assert.equal(compactAnswerForModel(checked).thinking, answer.thinking);
    assert.throws(() => inputAppends({ ...record, messages: [...record.messages, ...appended] }, input), /no pending/);
    assert.throws(() => inputAppends(record, { ...input, answer }), /does not match/);
    assert.throws(() => inputAppends(record, { ...input, answer: { ...checked, dismissed: true } }), /does not match/);
    assert.throws(() => inputAppends({ ...record, messages: [call({ question: "Plain question" })] }, input), /coding question/);
});
