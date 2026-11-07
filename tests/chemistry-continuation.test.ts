import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { questionChemistryContinuation, questionStructureContinuation } from "../src/core/chemistry-continuation.ts";
import { explainInputBase, focusedExplainInputSchema, askInputSchema } from "../src/core/question-core.ts";
import { parseAskInput, parseExplainInput } from "../src/core/tool-parts.ts";
import type { LhViewMessage, LhViewPart } from "../src/core/view.ts";
import { projectView } from "../src/core/view.ts";
import { pendingQuestionOf, type LhMessage } from "../src/core/native-messages.ts";
import { curvedArrowsDocument } from "./fixtures/curved-arrows.ts";

const synthesis = () => ({ ...curvedArrowsDocument, steps: [
	{ ...curvedArrowsDocument, id: "sn2", name: "SN2" },
	{ ...curvedArrowsDocument, id: "oxonium", name: "Intermediate" },
	{ ...curvedArrowsDocument, id: "product", name: "Final product" },
] });
const previous = (extra: Partial<LhViewPart> = {}): LhViewPart => ({
	type: "tool-explain", toolCallId: "previous", state: "output-available",
	input: { question: "Draw the mechanism.", nodeId: "ring-expansion" }, output: { molecule: synthesis() }, ...extra,
});
const current = (input: Record<string, unknown> = {}): LhViewPart => ({
	type: "tool-explain", toolCallId: "current", state: "input-available",
	input: { nodeId: "ring-expansion", question: "Make the requested corrections.", correctAnswer: "The corrected structure.", reusePreviousStructure: true, ...input },
});
const messages = (...parts: LhViewPart[]): LhViewMessage[] => [{ id: "assistant", role: "assistant", parts }];

test("direct-edit questions receive independent complete synthesis snapshots", () => {
	const answer = synthesis();
	const history = messages(previous({ output: { molecule: answer } }), current());
	const copy = questionStructureContinuation(history, "current")!;
	assert.deepEqual(copy, answer);
	copy.steps![0]!.name = "Corrected SN2";
	copy.steps![1]!.ket = '{"revised":true}';
	assert.equal(answer.steps[0]!.name, "SN2");
	assert.equal(answer.steps[1]!.ket, curvedArrowsDocument.ket);
	assert.deepEqual(questionStructureContinuation(history, "current"), answer);
});

test("already-posed repair and product-completion questions work without a reuse flag", () => {
	for (const question of [
		"**Working toward Problem Set 6 · Question 3d (p. 1).** Repair only the first two frames of your existing mechanism:\n- Add the missing bond-breaking arrow to each substitution.\nKeep your final product unchanged.",
		"Complete **only your final product drawing** by specifying the two H stereobonds.",
		"Edit your previous synthesis to include the missing arrow.",
	]) {
		assert.deepEqual(questionStructureContinuation(messages(previous(), current({ question, reusePreviousStructure: undefined })), "current"), synthesis(), question);
	}
	assert.ok(questionStructureContinuation(messages(previous(), current({ question: "One last repair.", details: "Correct your existing mechanism.", reusePreviousStructure: undefined })), "current"));
});

test("new questions, conceptual checks, hidden solutions, and explicit opt-outs do not inherit drawings", () => {
	for (const input of [
		{ question: "Draw a mechanism for this new reaction." },
		{ question: "Why is your mechanism correct?" },
		{ question: "Which orbital accepts the electron pair?", correctAnswer: "Repair your previous mechanism.", choiceHints: [{ label: "Edit your structure." }] },
		{ question: "Repair your previous mechanism.", reusePreviousStructure: false },
	]) {
		assert.equal(questionStructureContinuation(messages(previous(), current({ reusePreviousStructure: undefined, ...input })), "current"), undefined);
	}
	for (const extra of [
		{ type: "tool-quiz" },
		{ type: "tool-explain", state: "input-streaming" },
		{ type: "tool-explain", state: "output-error" },
		{ input: { question: "Repair your previous mechanism.", reusePreviousStructure: true, options: [{ label: "A" }, { label: "B" }] } },
		{ input: { question: "Repair your previous mechanism.", reusePreviousStructure: true, codeExercise: {} } },
	]) assert.equal(questionStructureContinuation(messages(previous(), { ...current(), ...extra }), "current"), undefined);
});

test("reuse stays inside the current chat and question cutoff, with conservative legacy topic matching", () => {
	assert.equal(questionStructureContinuation(messages(current()), "current"), undefined);
	assert.equal(questionStructureContinuation(messages(previous(), current()), "absent"), undefined);
	assert.equal(questionStructureContinuation(messages(previous(), current({ question: "Repair your previous mechanism.", nodeId: "new-exercise", reusePreviousStructure: undefined })), "current"), undefined);
	assert.equal(questionStructureContinuation(messages(current(), previous()), "current"), undefined);
	const oldCopy = previous({ toolCallId: "current", output: { molecule: { ...curvedArrowsDocument, label: "Earlier occurrence" } } });
	assert.deepEqual(questionStructureContinuation(messages(oldCopy, previous(), current()), "current"), synthesis(), "a reused call ID resolves the last occurrence");
	const hidden = { ...curvedArrowsDocument, label: "Hidden solution" };
	assert.equal(questionStructureContinuation(messages(previous({ output: {}, input: { correctAnswer: hidden } }), current({ correctAnswer: hidden })), "current"), undefined);
});

test("explicit reuse can cross conceptual answers and plan nodes, while invalid drawings are ignored", () => {
	const conceptual = previous({ toolCallId: "conceptual", output: { text: "The carbon inverts." } });
	assert.deepEqual(questionStructureContinuation(messages(previous(), conceptual, current()), "current"), synthesis());
	assert.equal(questionStructureContinuation(messages(previous(), conceptual, current({ question: "Repair your previous mechanism.", reusePreviousStructure: undefined })), "current"), undefined);
	assert.deepEqual(questionStructureContinuation(messages(previous(), previous({ input: { nodeId: "stereochemistry" }, output: {} }), current({ nodeId: "stereochemistry" })), "current"), synthesis(), "an explicit edit can return to a synthesis introduced on an earlier conceptual plan node");
	for (const output of [{ molecule: { version: 1, smiles: "CCO" } }, { molecule: synthesis(), dismissed: true }, { molecule: synthesis(), dontKnow: true }]) {
		assert.equal(questionStructureContinuation(messages(previous({ output }), current()), "current"), undefined);
	}
});

test("the reuse flag survives question tool validation and display parsing", () => {
	for (const reusePreviousStructure of [true, false]) {
		const explain = { question: "Revise your mechanism.", correctAnswer: "The corrected mechanism.", reusePreviousStructure };
		const ask = { question: "Revise your mechanism.", reusePreviousStructure };
		assert.equal(Value.Check(explainInputBase, explain), true);
		assert.equal(Value.Check(focusedExplainInputSchema, { ...explain, type: "check", nodeId: "ring-expansion", choiceHints: [{ label: "A" }, { label: "B" }] }), true);
		assert.equal(Value.Check(askInputSchema, ask), true);
		assert.equal(parseExplainInput(explain)?.reusePreviousStructure, reusePreviousStructure);
		assert.equal(parseAskInput(ask)?.reusePreviousStructure, reusePreviousStructure);
	}
	assert.deepEqual(questionStructureContinuation(messages(previous(), current({ reusePreviousStructure: "true" })), "current"), synthesis(), "raw persisted booleans use the tool boundary's conversion");
	assert.equal(questionStructureContinuation(messages(previous(), current({ question: "Repair your previous mechanism.", reusePreviousStructure: "false" })), "current"), undefined);
});

const fence = (smiles: string, label: string) => `\`\`\`molecule\n${JSON.stringify({ smiles, label })}\n\`\`\``;

test("reference provenance follows the complete synthesis chain and retains only public problem molecules", () => {
	const original = previous({ toolCallId: "original", input: {
		question: `Draw the mechanism.\n${fence("CCO", "Starting material")}`,
		details: fence("C=O", "Reagent"), correctAnswer: fence("CF", "Hidden solution"),
		choiceHints: [{ label: fence("CCl", "Hidden hint") }],
	} });
	const middle = previous({ toolCallId: "middle", input: {
		question: `Repair your previous synthesis.\n${fence("N", "New reagent")}`,
		correctAnswer: "The corrected structure.", reusePreviousStructure: true,
	} });
	const history = messages(
		{ type: "text", text: fence("Br", "Unrelated earlier problem") }, previous({ toolCallId: "unrelated" }),
		{ type: "text", text: fence("O", "Original public introduction") }, original,
		middle, previous({ toolCallId: "conceptual", output: { text: "An electrophile." } }), current(),
	);
	const result = questionChemistryContinuation(history, "current", "lesson")!;
	assert.deepEqual(result.molecule, synthesis());
	assert.deepEqual(result.referenceDraftKeys, ["question:lesson:middle", "question:lesson:original"]);
	assert.deepEqual(result.problemReferences.map(reference => reference.source.smiles), ["N", "O", "CCO", "C=O"]);
	assert.doesNotMatch(JSON.stringify(result.problemReferences), /Hidden|Unrelated|CF|CCl/);
	assert.deepEqual(questionChemistryContinuation(history, "current", "other-lesson")!.referenceDraftKeys, ["question:other-lesson:middle", "question:other-lesson:original"]);
	assert.equal(questionChemistryContinuation(messages(original, current({ reusePreviousStructure: false })), "current", "lesson"), undefined);
	assert.equal(questionChemistryContinuation(history, "current", ""), undefined);
});

test("answered questions keep their exact native draft keys when tool-call IDs were reused", () => {
	const teacher = (id: string, question: string, reusePreviousStructure?: boolean): LhMessage => ({
		id, role: "assistant", content: [{ type: "toolCall", id: "call_0", name: "explain", arguments: { question, correctAnswer: "A mechanism.", reusePreviousStructure } }],
		stopReason: "toolUse", timestamp: 0, provider: "openrouter", model: "test",
	} as unknown as LhMessage);
	const record: LhMessage[] = [
		teacher("original-message", `Draw the mechanism.\n${fence("CCO", "Original reagent")}`),
		{ id: "original-answer", role: "toolResult", toolCallId: "call_0", toolName: "explain", content: [], details: { molecule: synthesis() }, isError: false, timestamp: 1 },
		teacher("current-message", "Repair your previous synthesis.", true),
	];
	const pending = pendingQuestionOf(record)!;
	const view = projectView(record);
	const originalPart = view.flatMap(message => message.parts).find(part => part.state === "output-available")!;
	assert.equal(originalPart.questionKey, JSON.stringify(["original-message", 0, "call_0"]));
	assert.equal(view.flatMap(message => message.parts).find(part => part.state === "input-available")!.questionKey, pending.key);
	const result = questionChemistryContinuation(view, "call_0", "lesson")!;
	assert.deepEqual(result.referenceDraftKeys, [`question:lesson:${originalPart.questionKey}`]);
	assert.equal(result.problemReferences[0]!.name, "Original reagent");
});
