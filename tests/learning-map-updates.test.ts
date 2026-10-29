import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { ChatRecord, GraphNode, ExtractionRunUsage } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newGraphContextMessage, newThinkingMessage } from "../src/core/native-messages.ts";
import { createConceptSessionRequest } from "../src/core/learning-session.ts";
import { parseLearningContribution } from "../src/core/learning-graph-validation.ts";
import { buildLearningGraphSnapshot, emptyLearningGraphState, mergeLearningContribution, patchLearningNode } from "../src/core/learning-graph.ts";
import { learningSubjectId, scopeLearningGraphToSubject } from "../src/core/learning-subjects.ts";
import { abortExtraction, createExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import {
	learningBatches, learningContribution, learningFingerprint, learningPassages,
	runLearningMap, validateLearningSubmit, LEARNING_MAP_INSTRUCTIONS, type LearningSubmit,
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
	it("keeps generated launch context out of evidence and assesses later work against the selected planned identity", async () => {
		const request = createConceptSessionRequest(node, "practice");
		const marker = newGraphContextMessage([{ id: "n_old_growth", name: node.name, statement: node.statement }], [], {
			nodeId: "n_old_growth", mode: "practice", launchPrompt: request.title,
			progress: "comfortable", symbols: [{ notation: "γ", meaning: "Growth factor" }], prerequisites: [],
		});
		const chat = record([marker, learner("opening", request.title), teacher("t1", "Explain the amount after two periods."), learner("u1", "Each period multiplies by gamma, so the two-period factor is gamma squared.")]);
		const passages = learningPassages(chat);
		assert.deepEqual(passages.filter((passage) => passage.learnerEvidence).map((passage) => passage.id), ["u1"]);
		assert.match(validateLearningSubmit(assessment(["opening"]), [node], passages)!, /actual learner/);
		assert.match(validateLearningSubmit(assessment([marker.id]), [node], passages)!, /actual learner/);
		const faux = createFauxCore({});
		let modelPrompt = "";
		faux.setResponses([(context) => {
			modelPrompt = JSON.stringify(context.messages);
			return fauxAssistantMessage([fauxToolCall("submit_learning_map", assessment(["u1"]) as unknown as ToolCall["arguments"])], { stopReason: "toolUse" });
		}]);
		const manyNodes = [...Array.from({ length: 125 }, (_, index) => ({ ...node, id: `n_other_${index}`, name: "Exponential growth", statement: `Unrelated statement ${index}` })), node];
		const contribution = await runLearningMap({ record: chat, passages, nodes: manyNodes, idAliases: { n_old_growth: node.id }, groups: [], engine: { model: faux.getModel(), streamFn: faux.streamSimple }, onStep: () => undefined });
		assert.match(modelPrompt, /SELECTED CONCEPT IDS/);
		assert.match(modelPrompt, /n_growth/);
		assert.match(modelPrompt, /Exponential growth has a constant proportional rate/, "the selected node must be included in the bounded concept list");
		assert.doesNotMatch(modelPrompt, /n_old_growth|Recorded understanding|Growth factor/);
		assert.equal(contribution.nodes[0]!.nodeId, node.id);
		assert.deepEqual(contribution.nodes[0]!.progressEvidence![0]!.provenance, [{ chatId: chat.id, messageId: "u1" }]);
	});

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

describe("automatic learning subjects", () => {
	it("persists source-specific subjects for existing, shared and planned concepts without understanding evidence", async () => {
		const cpp = { ...node, id: "n_cpp", name: "Dynamic allocation", statement: "Dynamic allocation reserves storage at runtime." };
		const mechanics = { ...node, id: "n_mechanics", name: "Stationary action", statement: "Physical motion makes action stationary." };
		const shared = { ...node, id: "n_vectors", name: "Vectors", statement: "Vectors have magnitude and direction." };
		const haircutting = { ...node, id: "n_haircutting", name: "Cutting elevation", statement: "Elevation changes the weight distribution of a haircut." };
		const original = mergeLearningContribution(emptyLearningGraphState(), { sourceId: "prior", updatedAt: date, prerequisites: [], groups: [], nodes: [
			{ nodeId: cpp.id, subjects: ["C++ & systems programming"] },
			{ nodeId: mechanics.id, subjects: ["Advanced mechanics"] },
			{ nodeId: haircutting.id, subjects: ["Haircutting"] },
		] });
		const existing = buildLearningGraphSnapshot([cpp, mechanics, shared, haircutting, node], original).nodes;
		const chat = record([teacher("t1", "In this C++ course, allocation leads to resource ownership and RAII. We use mathematical vectors to implement a simulation. In Advanced mechanics, those vectors describe motion and stationary action.")]);
		const metadata = (nodeId: string, subjects?: string[]) => ({ nodeId, ...(subjects ? { subjects } : {}), tags: ["vectors"], symbols: [], progressEvidence: [] });
		const value: LearningSubmit = {
			concepts: [{ id: "c1", name: "RAII", statement: "Resource lifetime is bound to object lifetime.", messageIds: [] }],
			nodes: [metadata(cpp.id, [" c++ & systems programming ", "C++ & systems programming"]), metadata(mechanics.id, ["Advanced mechanics"]), metadata(shared.id, ["C++ & systems programming", "Advanced mechanics"]), metadata("c1", ["C++ & systems programming"]), metadata(node.id)],
			prerequisites: [{ from: node.id, to: cpp.id, explanation: "Inferred curriculum relationship for the example; connectivity alone is not subject membership.", messageIds: [] }],
			groups: [{ id: "cpp-resource-lifetime", name: "Resource lifetime", description: "Allocation and ownership in C++", members: [cpp.id, "c1"] }],
		};
		let prompt = "";
		let searchResult = "";
		const faux = createFauxCore({});
		faux.setResponses([
			(context) => { prompt = JSON.stringify(context.messages); return fauxAssistantMessage([fauxToolCall("find_learning_concepts", { query: "Dynamic allocation" })], { stopReason: "toolUse" }); },
			(context) => { searchResult = JSON.stringify(context.messages.filter((message) => message.role === "toolResult")); return fauxAssistantMessage([fauxToolCall("submit_learning_map", value as unknown as ToolCall["arguments"])], { stopReason: "toolUse" }); },
		]);
		const saved = await runLearningMap({ record: chat, passages: learningPassages(chat), nodes: existing, groups: [], engine: { model: faux.getModel(), streamFn: faux.streamSimple }, onStep: () => undefined });
		assert.match(prompt, /EXISTING SUBJECT NAMES/);
		assert.match(prompt, /subjects.*C\+\+ & systems programming/);
		assert.match(searchResult, /subjects.*C\+\+ & systems programming/);
		assert.match(LEARNING_MAP_INSTRUCTIONS, /generic prerequisite, graph connection, shared tag/);
		assert.match(LEARNING_MAP_INSTRUCTIONS, /within the SAME subject/);
		assert.match(LEARNING_MAP_INSTRUCTIONS, /open vocabulary, not a fixed taxonomy/);
		assert.deepEqual(saved.nodes.find((item) => item.nodeId === cpp.id)!.subjects, ["C++ & systems programming"]);
		assert.equal(saved.nodes.find((item) => item.nodeId === node.id)!.subjects, undefined, "legacy omission does not copy subjects from tags or connected nodes");
		assert.ok(saved.nodes.every((item) => !item.subjects?.includes("Haircutting")), "global vocabulary is never spread to unrelated nodes");
		const snapshot = buildLearningGraphSnapshot([cpp, mechanics, shared, haircutting, node], mergeLearningContribution(original, saved));
		const future = snapshot.nodes.find((item) => item.name === "RAII")!;
		assert.deepEqual(future.subjects, ["C++ & systems programming"]);
		assert.equal(future.future, true);
		assert.deepEqual(future.provenance, []);
		assert.deepEqual(snapshot.nodes.find((item) => item.id === shared.id)!.subjects, ["C++ & systems programming", "Advanced mechanics"]);
		assert.ok(snapshot.nodes.every((item) => item.progress === "unassessed" && item.progressEvidence.length === 0));
	});

	it("retries a reused group id that would merge separately classified subjects", async () => {
		const cpp = { ...node, id: "n_cpp_group", subjects: ["C++ & systems programming"] };
		const mechanics = { ...node, id: "n_mechanics_group", subjects: ["Advanced mechanics"] };
		const oldGroup = { id: "foundations", name: "Mechanics foundations", description: "Mechanics study group", members: [mechanics.id] };
		let calls = 0;
		const faux = createFauxCore({});
		faux.setResponses(["foundations", "cpp-foundations"].map((id) => () => {
			calls++;
			return fauxAssistantMessage([fauxToolCall("submit_learning_map", { ...empty(), groups: [{ id, name: "C++ foundations", description: "C++ study group", members: [cpp.id] }] } as unknown as ToolCall["arguments"])], { stopReason: "toolUse" });
		}));
		const result = await runLearningMap({ record: record([]), passages: [], nodes: [cpp, mechanics], groups: [oldGroup], engine: { model: faux.getModel(), streamFn: faux.streamSimple }, onStep: () => undefined });
		assert.equal(calls, 2);
		assert.equal(result.groups[0]!.id, "cpp-foundations");
	});

	it("cannot use proposed automatic labels to bypass a manual subject or Unassigned correction", () => {
		const cpp = { ...node, id: "n_cpp_override" };
		const mechanics = { ...node, id: "n_mechanics_override" };
		const automatic = mergeLearningContribution(emptyLearningGraphState(), { sourceId: "subject_corrections", updatedAt: date, nodes: [{ nodeId: cpp.id, subjects: ["C++"] }, { nodeId: mechanics.id, subjects: ["Mechanics"] }], prerequisites: [], groups: [] });
		const proposed: LearningSubmit = { ...empty(), nodes: [{ nodeId: cpp.id, subjects: ["Mechanics"], tags: [], symbols: [], progressEvidence: [] }], groups: [{ id: "mechanics-subject", name: "Mechanics", description: "Mechanics study group", members: [cpp.id, mechanics.id] }] };
		for (const subjects of [["C++"], []]) {
			const corrected = patchLearningNode(automatic, cpp.id, { subjects });
			const effective = buildLearningGraphSnapshot([cpp, mechanics], corrected).nodes;
			assert.match(validateLearningSubmit(proposed, effective, [])!, /mixes subjects/);
		}
		assert.equal(validateLearningSubmit(proposed, buildLearningGraphSnapshot([cpp, mechanics], automatic).nodes, []), null, "a source may explicitly add a shared subject when no correction blocks it");
		assert.equal(validateLearningSubmit(proposed, [cpp, mechanics], []), null, "legacy contexts without subject fields remain supported");
	});

	it("keeps explicitly classified study groups separate even when all their concepts are shared", async () => {
		const shared = { ...node, id: "n_shared_groups" };
		const original = mergeLearningContribution(emptyLearningGraphState(), { sourceId: "cpp_source", updatedAt: date, nodes: [{ nodeId: shared.id, subjects: ["C++", "Mechanics"] }], prerequisites: [], groups: [{ id: "cpp-vectors", name: "C++ vectors", subjects: ["C++"], description: "Programming study group", members: [shared.id] }] });
		const snapshot = buildLearningGraphSnapshot([shared], original);
		const group = (id: string): LearningSubmit => ({ ...empty(), groups: [{ id, name: "Mechanics vectors", subjects: [" mechanics ", "Mechanics"], description: "Mechanics study group", members: [shared.id] }] });
		let calls = 0;
		const faux = createFauxCore({});
		faux.setResponses(["cpp-vectors", "mechanics-vectors"].map((id) => () => {
			calls++;
			return fauxAssistantMessage([fauxToolCall("submit_learning_map", group(id) as unknown as ToolCall["arguments"])], { stopReason: "toolUse" });
		}));
		const result = await runLearningMap({ record: record([]), passages: [], nodes: snapshot.nodes, groups: snapshot.groups, engine: { model: faux.getModel(), streamFn: faux.streamSimple }, onStep: () => undefined });
		assert.equal(calls, 2, "an existing group id cannot silently acquire another subject");
		assert.deepEqual(result.groups[0]!.subjects, ["Mechanics"]);
		const saved = buildLearningGraphSnapshot([shared], mergeLearningContribution(original, result));
		assert.deepEqual(scopeLearningGraphToSubject(saved, learningSubjectId("C++")).groups.map((item) => item.id), ["cpp-vectors"]);
		assert.deepEqual(scopeLearningGraphToSubject(saved, learningSubjectId("Mechanics")).groups.map((item) => item.id), ["mechanics-vectors"]);
		assert.equal(saved.nodes[0]!.progress, "unassessed");
		const corrected = buildLearningGraphSnapshot([shared], patchLearningNode(original, shared.id, { subjects: ["C++"] }));
		assert.match(validateLearningSubmit(group("new-mechanics"), corrected.nodes, [])!, /not shared by every member/);
		const planned: LearningSubmit = { ...empty(), concepts: [{ id: "c1", name: "New concept", statement: "A new concept needs classification.", messageIds: [] }], groups: [{ id: "new-mechanics", name: "Mechanics", subjects: ["Mechanics"], description: "", members: ["c1"] }] };
		assert.match(validateLearningSubmit(planned, [], [])!, /classify new members explicitly/);
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

	it("resumes an interrupted initial backfill from its saved message checkpoint", async () => {
		const chat = {
			...record([1, 2, 3].map((index) => ({
				...learner(`u${index}`, `Independent explanation of proportional growth ${index}. `.repeat(10)),
				timestamp: timestamp + index,
			}))),
			id: "learning_resume_test",
		};
		let state = emptyLearningGraphState();
		let saves = 0;
		const makePipeline = (faux: ReturnType<typeof createFauxCore>) => createExtractionPipeline({
			chatStore: { getChat: () => chat, appendExtractionUsage: () => undefined } as unknown as ChatStore,
			graphStore: {} as GraphStore, getChunkTokens: () => 10,
			extractor: { model: faux.getModel(), streamFn: faux.streamSimple },
			learning: {
				readState: () => state, snapshot: () => buildLearningGraphSnapshot([node], state),
				saveContribution: (contribution) => { state = mergeLearningContribution(state, contribution); saves++; },
			},
		});
		const response = (id: string) => fauxAssistantMessage([
			fauxToolCall("submit_learning_map", assessment([id]) as unknown as ToolCall["arguments"]),
		], { stopReason: "toolUse" });
		const interrupted = createFauxCore({});
		interrupted.setResponses([
			() => response("u1"),
			() => { assert.equal(abortExtraction(chat.id), true); return response("u2"); },
		]);
		await assert.rejects(makePipeline(interrupted).updateLearning!(chat.id, { force: true }), { name: "AbortError" });
		assert.equal(saves, 1, "the interrupted batch must not save a partial result");
		const checkpoint = structuredClone(state.contributions[chat.id]!);
		assert.deepEqual(Object.keys(checkpoint.messageFingerprints!), ["u1"]);
		assert.equal(checkpoint.fingerprint, undefined, "incomplete backfill has no full-source fingerprint");

		// Recreate the pipeline as a restarted server would, retaining only the saved state.
		const resumed = createFauxCore({});
		let resumedCalls = 0;
		resumed.setResponses(["u2", "u3"].map((id) => () => { resumedCalls++; return response(id); }));
		const pipeline = makePipeline(resumed);
		await pipeline.updateLearning!(chat.id, { force: false });
		assert.equal(resumedCalls, 2, "only the two unfinished batches need model requests");
		assert.equal(saves, 3);
		const completed = state.contributions[chat.id]!;
		assert.deepEqual(completed.messageFingerprints, Object.fromEntries(learningPassages(chat).map((passage) => [passage.id, passage.fingerprint])));
		assert.equal(completed.messageFingerprints!.u1, checkpoint.messageFingerprints!.u1);
		assert.equal(completed.fingerprint, learningFingerprint(chat));
		const evidence = completed.nodes.find((item) => item.nodeId === node.id)!.progressEvidence!;
		assert.deepEqual(evidence.flatMap((item) => item.provenance.map((anchor) => anchor.messageId)), ["u1", "u2", "u3"], "earlier learner evidence survives the restart");
		await pipeline.updateLearning!(chat.id, { force: false });
		assert.equal(resumedCalls, 2, "the final fingerprint prevents another unchanged update");
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
