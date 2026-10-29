import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { ChatRecord, GraphNode, ExtractionRunUsage } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newThinkingMessage } from "../src/core/native-messages.ts";
import { parseLearningContribution } from "../src/core/learning-graph-validation.ts";
import { buildLearningGraphSnapshot, emptyLearningGraphState, mergeLearningContribution, patchLearningNode } from "../src/core/learning-graph.ts";
import { createExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import {
	learningBatches, learningContribution, learningFingerprint, learningPassages,
	runLearningMap, validateLearningSubmit, type LearningSubmit,
} from "../src/agent/subagents/learning-map.ts";

const date = "2026-10-20T12:00:00.000Z";
const timestamp = Date.parse(date);
const node: GraphNode = { id: "n_growth", name: "Exponential growth", statement: "Exponential growth has a constant proportional rate.", aliases: [], createdAt: date, provenance: [] };
function teacher(id: string, text: string): LhMessage {
	return { id, role: "assistant", content: [{ type: "text", text }, { type: "thinking", thinking: "hidden teacher reasoning" }], timestamp, stopReason: "stop" } as LhMessage;
}
function learner(id: string, text: string): LhMessage { return { id, role: "user", content: text, timestamp }; }
function answer(id: string, fields: Record<string, unknown>): LhMessage {
	return { id, role: "toolResult", toolCallId: `call_${id}`, toolName: "quiz", isError: false, content: [{ type: "text", text: "serialized model view" }], details: fields, timestamp } as LhMessage;
}
function record(messages: LhMessage[]): ChatRecord {
	return { id: "learning_test", title: "Growth", createdAt: date, updatedAt: date, messages };
}
const empty = (): LearningSubmit => ({ concepts: [], nodes: [], prerequisites: [], groups: [] });
function assessment(messageIds: string[], state: "learning" | "comfortable" = "comfortable"): LearningSubmit {
	return { ...empty(), nodes: [{ nodeId: node.id, tags: ["dynamics"], symbols: [], progressEvidence: [{ state, messageIds, explanation: "Explains proportional growth in their own words.", support: "independent_explanation" }] }] };
}

describe("learning-map evidence boundary", () => {
	it("includes practice thinking and the problem statement, never the stored model solution", () => {
		const problem = teacher("problem1", "");
		if (problem.role === "assistant") problem.content = [{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "Find the growth after three periods", modelSolution: "MODEL SOLUTION" } }];
		const thinking = newThinkingMessage("p1", "Each period multiplies by gamma, so after three periods the factor is gamma cubed.");
		const passages = learningPassages(record([problem, thinking]));
		assert.match(passages[0]!.text, /Find the growth/);
		assert.doesNotMatch(passages.map((p) => p.text).join("\n"), /MODEL SOLUTION/);
		assert.equal(passages[1]!.id, thinking.id);
		assert.equal(passages[1]!.learnerEvidence, true);
		assert.equal(validateLearningSubmit(assessment([thinking.id]), [node], passages), null);
	});

	it("separates learner answers from teacher/model answers and hidden reasoning", () => {
		const passages = learningPassages(record([
			teacher("t1", "The exponential growth factor is gamma."),
			learner("u1", "Doubling every period means growth is proportional to the current amount."),
			answer("r1", { questionText: "Explain the growth factor", text: "It scales the amount each period", correct: true, committed: "MODEL ANSWER", explanation: "MODEL EXPLANATION" }),
			answer("r2", { dismissed: true }),
		]));
		assert.equal(passages.length, 3);
		assert.deepEqual(passages.filter((p) => p.learnerEvidence).map((p) => p.id), ["u1", "r1"]);
		assert.doesNotMatch(passages.map((p) => p.text).join("\n"), /hidden teacher|MODEL ANSWER|MODEL EXPLANATION|serialized model/);
		assert.equal(passages[0]!.canSupportComfortable, false);
	});

	it("rejects teacher-only, fabricated and incorrect evidence of comfort", () => {
		const passages = learningPassages(record([
			teacher("t1", "Worked solution"), learner("u1", "My independent explanation"),
			answer("r1", { questionText: "Rate?", correct: false, thinking: "I assumed a constant absolute change" }),
			answer("r2", { questionText: "Rate?", correct: true, answers: [{ index: 1 }] }),
		]));
		assert.match(validateLearningSubmit(assessment(["t1"]), [node], passages)!, /actual learner/);
		assert.match(validateLearningSubmit(assessment(["invented"]), [node], passages)!, /actual learner/);
		assert.match(validateLearningSubmit(assessment(["r1"]), [node], passages)!, /does not support/);
		assert.match(validateLearningSubmit(assessment(["r2"]), [node], passages)!, /does not support/);
		assert.equal(validateLearningSubmit(assessment(["u1"]), [node], passages), null);
		assert.equal(validateLearningSubmit(assessment(["r1"], "learning"), [node], passages), null);
	});

	it("keeps unseen concepts unassessed and anchors actual evidence to when it occurred", () => {
		const passages = learningPassages(record([learner("u1", "Independent explanation")]));
		const value: LearningSubmit = {
			...assessment(["u1"]),
			concepts: [{ id: "c1", name: "Logarithms", statement: "Logarithms invert exponentiation.", messageIds: [] }],
			prerequisites: [{ from: node.id, to: "c1", explanation: "Inferred curriculum relationship: inverses build on the original operation.", messageIds: [] }],
			groups: [{ id: "exponential-models", name: "Exponential models", description: "Growth and its inverse", members: [node.id, "c1"] }],
		};
		const contribution = learningContribution(value, "learning_test", passages, "2026-10-28T12:00:00.000Z");
		assert.deepEqual(contribution.futureNodes![0]!.provenance, []);
		assert.equal(contribution.nodes[0]!.progressEvidence![0]!.observedAt, date);
		assert.equal(contribution.prerequisites[0]!.to, contribution.futureNodes![0]!.id);
		const snapshot = buildLearningGraphSnapshot([node], mergeLearningContribution(emptyLearningGraphState(), contribution));
		const planned = snapshot.nodes.find((item) => item.id !== node.id)!;
		assert.equal(planned.future, true);
		assert.equal(planned.progress, "unassessed");
		assert.equal(planned.ready, true);
	});

	it("new teaching can encounter a planned concept without claiming understanding", () => {
		const passages = learningPassages(record([teacher("t1", "Growth is proportional to the current amount.")]));
		const value: LearningSubmit = { ...empty(), nodes: [{ nodeId: node.id, encounteredMessageIds: ["t1"], tags: [], symbols: [], progressEvidence: [] }] };
		const decorated = buildLearningGraphSnapshot([node], emptyLearningGraphState()).nodes[0]!;
		const contribution = learningContribution(value, "learning_test", passages, date, [decorated]);
		assert.doesNotThrow(() => parseLearningContribution(contribution), "effective UI fields must not leak into strict stored node schema");
		assert.deepEqual(contribution.futureNodes![0]!.provenance, [{ chatId: "learning_test", messageId: "t1" }]);
		assert.deepEqual(contribution.nodes[0]!.progressEvidence, []);
	});

	it("requires valid concept endpoints and source anchors for automatic structure", () => {
		const value = { ...empty(), prerequisites: [{ from: node.id, to: "missing", explanation: "Required first", messageIds: [] }] };
		assert.match(validateLearningSubmit(value, [node], [])!, /Invalid prerequisite/);
		value.prerequisites[0]!.to = node.id;
		assert.match(validateLearningSubmit(value, [node], [])!, /Invalid prerequisite/);
	});

	it("retries invalid persisted identifiers before accepting a model submission", async () => {
		let calls = 0;
		const faux = createFauxCore({});
		faux.setResponses(["__proto__", "group with spaces", "exponential-models"].map((id) => () => {
			calls++;
			const value: LearningSubmit = { ...empty(), groups: [{ id, name: "Exponential models", description: "Growth models", members: [node.id] }] };
			return fauxAssistantMessage([fauxToolCall("submit_learning_map", value as unknown as ToolCall["arguments"])], { stopReason: "toolUse" });
		}));
		const result = await runLearningMap({
			record: record([]), passages: [], nodes: [node], groups: [],
			engine: { model: faux.getModel(), streamFn: faux.streamSimple }, onStep: () => undefined,
		});
		assert.equal(calls, 3);
		assert.equal(result.groups[0]!.id, "exponential-models");
		assert.doesNotThrow(() => parseLearningContribution(result));
	});

	it("sanitizes whitespace-only aliases and tags before persistence validation", () => {
		const value: LearningSubmit = { ...empty(), nodes: [{ nodeId: node.id, tags: ["   ", " dynamics "], symbols: [{ notation: "γ", meaning: " Growth factor ", aliases: ["  ", " gamma ", "\\gamma"], messageIds: [] }], progressEvidence: [] }] };
		assert.equal(validateLearningSubmit(value, [node], []), null);
		const saved = parseLearningContribution(learningContribution(value, "learning_test", [], date));
		assert.deepEqual(saved.nodes[0]!.tags, ["dynamics"]);
		assert.deepEqual(saved.nodes[0]!.symbols![0]!.aliases, ["gamma", "\\gamma"]);
		assert.equal(saved.nodes[0]!.symbols![0]!.meaning, "Growth factor");
	});
});

describe("incremental learning updates", () => {
	it("processes changed messages with context and fingerprints ignore usage-only writes", () => {
		const chat = record([teacher("t1", "Question context"), learner("u1", "My answer")]);
		const passages = learningPassages(chat);
		const processed = Object.fromEntries(passages.map((p) => [p.id, p.fingerprint]));
		assert.deepEqual(learningBatches(passages, processed), []);
		chat.messages.push(teacher("t2", "A new explanation"));
		assert.deepEqual(learningBatches(learningPassages(chat), processed)[0]!.map((p) => p.id), ["t1", "u1", "t2"]);
		const fingerprint = learningFingerprint(chat);
		chat.updatedAt = "2026-11-01T00:00:00.000Z";
		assert.equal(learningFingerprint(chat), fingerprint);
	});

	it("runs automatically, checkpoints evidence, tracks spend, and preserves a personal correction", async () => {
		const chat = record([teacher("t1", "Explain growth"), learner("u1", "A constant fraction of the current amount is added per time unit.")]);
		let state = patchLearningNode(emptyLearningGraphState(), node.id, { progress: "learning" });
		const usage: ExtractionRunUsage[] = [];
		let calls = 0;
		const faux = createFauxCore({});
		faux.setResponses([() => {
			calls++;
			return fauxAssistantMessage([fauxToolCall("submit_learning_map", assessment(["u1"]) as unknown as ToolCall["arguments"])], { stopReason: "toolUse" });
		}]);
		const pipeline = createExtractionPipeline({
			chatStore: { getChat: () => chat, appendExtractionUsage: (_id: string, entry: ExtractionRunUsage) => usage.push(entry) } as unknown as ChatStore,
			graphStore: {} as GraphStore,
			extractor: { model: faux.getModel(), streamFn: faux.streamSimple },
			learning: {
				readState: () => state,
				snapshot: () => buildLearningGraphSnapshot([node], state),
				saveContribution: (contribution) => { state = mergeLearningContribution(state, contribution); },
			},
		});
		await pipeline.updateLearning!(chat.id);
		await pipeline.updateLearning!(chat.id);
		assert.equal(calls, 1, "unchanged evidence must not spend another model call");
		assert.equal(usage.length, 1);
		assert.ok(usage[0]!.stages.extractor.steps.length > 0);
		assert.equal(state.contributions[chat.id]!.fingerprint, learningFingerprint(chat));
		assert.equal(Object.keys(state.contributions[chat.id]!.messageFingerprints!).length, 2);
		const effective = buildLearningGraphSnapshot([node], state).nodes[0]!;
		assert.equal(effective.automaticProgress, "comfortable");
		assert.equal(effective.progress, "learning");
	});

	it("a learner answer arriving during a model call is queued and assessed afterward", async () => {
		const chat = { ...record([learner("u1", "The rate is proportional to the amount")]), id: "learning_queue_test" };
		let state = emptyLearningGraphState();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let started!: () => void;
		const firstStarted = new Promise<void>((resolve) => { started = resolve; });
		let completed!: () => void;
		const secondSaved = new Promise<void>((resolve) => { completed = resolve; });
		let calls = 0;
		const faux = createFauxCore({});
		faux.setResponses([
			async () => { calls++; started(); await gate; return fauxAssistantMessage([fauxToolCall("submit_learning_map", assessment(["u1"]) as unknown as ToolCall["arguments"])], { stopReason: "toolUse" }); },
			() => { calls++; return fauxAssistantMessage([fauxToolCall("submit_learning_map", assessment(["u2"], "learning") as unknown as ToolCall["arguments"])], { stopReason: "toolUse" }); },
		]);
		const pipeline = createExtractionPipeline({
			chatStore: { getChat: () => chat, appendExtractionUsage: () => undefined } as unknown as ChatStore,
			graphStore: {} as GraphStore,
			extractor: { model: faux.getModel(), streamFn: faux.streamSimple },
			learning: {
				readState: () => state, snapshot: () => buildLearningGraphSnapshot([node], state),
				saveContribution: (contribution) => { state = mergeLearningContribution(state, contribution); if (calls === 2) completed(); },
			},
		});
		const first = pipeline.updateLearning!(chat.id);
		await firstStarted;
		chat.messages = [...chat.messages, { ...learner("u2", "I still need a hint to solve it"), timestamp: timestamp + 1000 }];
		await pipeline.updateLearning!(chat.id);
		release();
		await first;
		await secondSaved;
		assert.equal(calls, 2);
		assert.equal(state.contributions[chat.id]!.fingerprint, learningFingerprint(chat));
		assert.equal(buildLearningGraphSnapshot([node], state).nodes[0]!.automaticProgress, "learning");
	});

	it("a deleted session cannot save a model result that was already in flight", async () => {
		const chat = { ...record([learner("u1", "My independent explanation")]), id: "learning_delete_test" };
		let exists = true;
		let writes = 0;
		const faux = createFauxCore({});
		faux.setResponses([() => {
			exists = false;
			return fauxAssistantMessage([fauxToolCall("submit_learning_map", assessment(["u1"]) as unknown as ToolCall["arguments"])], { stopReason: "toolUse" });
		}]);
		const state = emptyLearningGraphState();
		const pipeline = createExtractionPipeline({
			chatStore: { getChat: () => exists ? chat : null, appendExtractionUsage: () => undefined } as unknown as ChatStore,
			graphStore: {} as GraphStore,
			extractor: { model: faux.getModel(), streamFn: faux.streamSimple },
			learning: { readState: () => state, snapshot: () => buildLearningGraphSnapshot([node], state), saveContribution: () => { writes++; } },
		});
		await assert.rejects(pipeline.updateLearning!(chat.id), { name: "AbortError" });
		assert.equal(writes, 0);
	});
});
