import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChatInput, inputAppends } from "../src/core/input-events.ts";
import { activeProblemOf, newThinkingMessage, asAgentMessages, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { buildAnswer, compactAnswerForModel, type QuestionData } from "../src/core/question-core.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import { normalizeMolecule, normalizeMoleculeDocument } from "../src/server/chemistry.ts";
import type { MoleculeDocument } from "../src/core/chemistry.ts";

const ethanol = await normalizeMolecule({ smiles: "CCO" });

function call(tool: string, args: unknown, id = "call1"): LhMessage {
	return {
		id: `msg_${id}`, role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: args }],
		timestamp: 1, api: "faux", provider: "test", model: "test", stopReason: "toolUse",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as LhMessage;
}

function practiceRecord(): { messages: LhMessage[]; kind: string } {
	return { kind: "practice", messages: [
		call("problem", { statement: "Draw ethanol.", mode: "recall", chemistry: {}, modelSolution: "CCO" }),
		{ id: "ack", role: "toolResult", toolCallId: "call1", toolName: "problem", content: [{ type: "text", text: "Problem posed" }], details: null, isError: false, timestamp: 2 } as LhMessage,
	] };
}

const question: QuestionData = {
	id: "call1", kind: "explain", question: "Draw the alcohol.", mode: "text", options: [],
	committedAnswer: "Ethanol", createdAt: "2026-10-29T00:00:00Z",
};

describe("molecular answer records", () => {
	it("accepts a structure-only thinking submission and keeps legacy text inputs unchanged", () => {
		const input = parseChatInput({ type: "thinking", problemCallId: "call1", text: "", molecule: ethanol });
		assert.equal(input.type, "thinking");
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "call1", text: "Reasoning" }), { type: "thinking", problemCallId: "call1", text: "Reasoning" });
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "call1", text: "" }), /non-empty text/);
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "call1", text: "", molecule: { version: 99, smiles: "CCO" } }), /version/);
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "call1", text: "", molecule: { ...ethanol, ket: "not json" } }), /JSON/);
	});

	it("stores separate immutable snapshots for repeated attempts on the same active problem", () => {
		const draft = { ...ethanol, label: "First attempt" };
		const record = practiceRecord();
		const first = inputAppends(record, { type: "thinking", problemCallId: "call1", text: "An alcohol", molecule: draft })[0]!;
		draft.label = "Second attempt";
		const second = inputAppends({ ...record, messages: [...record.messages, first] }, { type: "thinking", problemCallId: "call1", text: "Revised", molecule: draft })[0]!;
		assert.equal(first.role, "custom");
		assert.equal(second.role, "custom");
		assert.equal((first as { details: { molecule: MoleculeDocument } }).details.molecule.label, "First attempt");
		assert.equal((second as { details: { molecule: MoleculeDocument } }).details.molecule.label, "Second attempt");
		assert.throws(() => inputAppends(record, { type: "thinking", problemCallId: "wrong", text: "", molecule: draft }), /no active problem/);
	});

	it("qualifies draft keys when older records reuse a problem call ID", () => {
		const first = practiceRecord();
		const firstKey = activeProblemOf(first.messages)?.key;
		const repeated = practiceRecord();
		repeated.messages[0]!.id = "second_problem_message";
		repeated.messages[1]!.id = "second_problem_ack";
		const secondKey = activeProblemOf([...first.messages, ...repeated.messages])?.key;
		assert.equal(firstKey, "call1");
		assert.notEqual(secondKey, firstKey);
		assert.match(secondKey!, /second_problem_message/);
	});

	it("carries actual structural source and reasoning into tutor context and portable export", () => {
		const message = newThinkingMessage("call1", "The hydroxyl is terminal.", { ...ethanol, ket: '{"root":{}}' });
		const model = JSON.stringify(toLlmMessages(asAgentMessages([message])));
		assert.match(model, /The hydroxyl is terminal/);
		assert.match(model, /Submitted molecular structure/);
		assert.match(model, /molfile/);
		assert.doesNotMatch(model, /ket/);
		const markdown = sessionMarkdown([message]);
		assert.match(markdown, /The hydroxyl is terminal/);
		const source = JSON.parse(markdown.match(/```molecule\n([^\n]+)\n```/)![1]!);
		assert.equal(source.molfile, ethanol.molfile);
		assert.equal(source.smiles, ethanol.smiles);
	});

	it("free-response answers include structures without changing multiple-choice grading", () => {
		const draft = { ...ethanol };
		const answer = buildAnswer(question, { molecule: draft });
		draft.smiles = "wrong client-side mutation";
		assert.equal(answer.molecule?.smiles, "CCO");
		assert.equal(answer.correct, undefined);
		assert.match(String(compactAnswerForModel(answer).molecule), /molfile/);
		const quiz = buildAnswer({ ...question, kind: "quiz", mode: "single-select", options: [{ value: "a", label: "A" }], correctIndices: [1] }, { molecule: ethanol, values: ["a"] });
		assert.equal(quiz.correct, true);
		assert.equal(quiz.molecule, undefined);
	});

	it("rejects structural payloads on multiple-choice and dismissed answers at the server record boundary", () => {
		const answer = buildAnswer(question, { molecule: ethanol });
		assert.throws(() => inputAppends({ messages: [call("quiz", { question: "Pick one", options: [{ label: "A", value: "a" }] })] }, { type: "answer", toolCallId: "call1", answer }), /free-response/);
		assert.throws(() => inputAppends({ messages: [call("ask_user_question", { question: "Pick one", options: [{ label: "A", value: "a" }] })] }, { type: "answer", toolCallId: "call1", answer: { ...answer, kind: "ask" } }), /free-response/);
		assert.throws(() => inputAppends({ messages: [call("recall", { question: "Draw ethanol", correctAnswer: "CCO" })] }, { type: "answer", toolCallId: "call1", answer: { ...answer, dismissed: true } }), /does not match/);
		const appended = inputAppends({ messages: [call("recall", { question: "Draw ethanol", correctAnswer: "CCO" })] }, { type: "answer", toolCallId: "call1", answer });
		assert.match(sessionMarkdown(appended), /```molecule/);
	});

	it("normalizes identity from Molfile and preserves editor document independently", async () => {
		const normalized = await normalizeMoleculeDocument({ ...ethanol, smiles: "c1ccccc1", ket: '{"root":{}}' });
		assert.equal(normalized.smiles, "CCO");
		assert.equal(normalized.ket, '{"root":{}}');
		assert.match(normalized.molfile, /M  END/);
		await assert.rejects(() => normalizeMoleculeDocument({ ...ethanol, molfile: "broken structure" }));
	});
});
