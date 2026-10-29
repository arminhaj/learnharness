import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphNode, LearningContribution, LearningGraphState, LearningProgress } from "../src/core/contracts.ts";
import {
	buildLearningGraphSnapshot, emptyLearningGraphState, matchesLearningConcept,
	mergeLearningContribution, patchLearningNode, patchLearningPrerequisite,
	reconcileLearningGraphState, removeLearningNode, removeLearningSource,
} from "../src/core/learning-graph.ts";
import { parseLearningNodePatch, parseLearningPrerequisitePatch } from "../src/core/learning-graph-validation.ts";
import { createLearningGraphStore } from "../src/store/learning-graph.ts";

const date = "2026-10-28T12:00:00.000Z";
const provenance = [{ chatId: "chat_a", messageId: "message_1" }];
const node = (id: string, statement = `Statement ${id}`): GraphNode => ({ id, name: id, statement, createdAt: date, aliases: [], provenance });
const contribution = (patch: Partial<LearningContribution> = {}): LearningContribution => ({ sourceId: "chat_a", updatedAt: date, nodes: [], prerequisites: [], groups: [], ...patch });
const edge = (from: string, to: string) => ({ from, to, explanation: `${from} prepares for ${to}`, provenance });
function progress(state: LearningGraphState, id: string, value: LearningProgress) { return patchLearningNode(state, id, { progress: value }); }

describe("learning graph meaning and corrections", () => {
	it("legacy nodes remain unassessed and acquire no fabricated prerequisite edges", () => {
		const input = [node("a"), node("b")];
		const snapshot = buildLearningGraphSnapshot(input);
		assert.equal(snapshot.nodes.length, 2);
		assert.deepEqual(snapshot.prerequisites, []);
		assert.deepEqual(snapshot.groups, []);
		assert.ok(snapshot.nodes.every((node) => node.progress === "unassessed" && node.ready && node.firstEncounteredAt === null));
		assert.deepEqual(buildLearningGraphSnapshot([]).nodes, []);
		assert.equal(input[0]!.name, "a");
	});

	it("automatic batches preserve explicit names, empty tags, symbols, and progress until reset", () => {
		let state = mergeLearningContribution(emptyLearningGraphState(), contribution({ nodes: [{ nodeId: "a", tags: ["physics"], symbols: [{ notation: "γ", meaning: "Growth factor", aliases: ["gamma"], provenance }], progressEvidence: [{ state: "learning", explanation: "Learner needs a hint", provenance, observedAt: date }] }] }));
		state = patchLearningNode(state, "a", { name: "My name", tags: [], symbols: [], progress: "comfortable" });
		state = mergeLearningContribution(state, contribution({ updatedAt: "2026-10-29T12:00:00.000Z", nodes: [{ nodeId: "a", tags: ["math"], progressEvidence: [{ state: "unassessed", explanation: "Insufficient new evidence", provenance, observedAt: "2026-10-29T12:00:00.000Z" }] }] }));
		const effective = buildLearningGraphSnapshot([node("a")], state).nodes[0]!;
		assert.equal(effective.name, "My name");
		assert.equal(effective.progress, "comfortable");
		assert.equal(effective.automaticProgress, "unassessed");
		assert.deepEqual(effective.tags, []);
		assert.deepEqual(effective.symbols, []);
		state = patchLearningNode(state, "a", { name: null, tags: null, symbols: null, progress: null });
		const reset = buildLearningGraphSnapshot([node("a")], state).nodes[0]!;
		assert.equal(reset.name, "a");
		assert.equal(reset.progress, "unassessed");
		assert.deepEqual(reset.tags, ["physics", "math"]);
		assert.equal(reset.symbols[0]!.notation, "γ");
	});

	it("readiness requires all prerequisites and never changes understanding", () => {
		let state = mergeLearningContribution(emptyLearningGraphState(), contribution({ prerequisites: [edge("a", "c"), edge("b", "c")] }));
		state = progress(state, "a", "comfortable");
		state = progress(state, "b", "learning");
		const input = [node("a"), node("b"), node("c")];
		let target = buildLearningGraphSnapshot(input, state).nodes.find((node) => node.id === "c")!;
		assert.equal(target.ready, false);
		assert.deepEqual(target.unmetPrerequisiteIds, ["b"]);
		state = progress(state, "b", "comfortable");
		target = buildLearningGraphSnapshot(input, state).nodes.find((node) => node.id === "c")!;
		assert.equal(target.ready, true);
		assert.equal(target.progress, "unassessed");
		state = progress(progress(state, "c", "comfortable"), "b", "learning");
		target = buildLearningGraphSnapshot(input, state).nodes.find((node) => node.id === "c")!;
		assert.equal(target.ready, false);
		assert.equal(target.progress, "comfortable", "prerequisite correction must not erase downstream learning");
	});

	it("disabled prerequisites survive extraction and reset restores automatic evidence", () => {
		const automatic = contribution({ prerequisites: [edge("a", "b")] });
		let state = mergeLearningContribution(emptyLearningGraphState(), automatic);
		state = patchLearningPrerequisite(state, { from: "a", to: "b", enabled: false });
		state = mergeLearningContribution(state, automatic);
		let snapshot = buildLearningGraphSnapshot([node("a"), node("b")], state);
		assert.equal(snapshot.prerequisites.length, 0);
		assert.equal(snapshot.prerequisiteCorrections[0]!.enabled, false);
		state = patchLearningPrerequisite(state, { from: "a", to: "b", enabled: null });
		snapshot = buildLearningGraphSnapshot([node("a"), node("b")], state);
		assert.equal(snapshot.prerequisites[0]!.origin, "automatic");
		state = patchLearningPrerequisite(state, { from: "a", to: "b", enabled: true, explanation: "My correction" });
		assert.equal(buildLearningGraphSnapshot([node("a"), node("b")], state).prerequisites[0]!.explanation, "My correction");
	});

	it("cycles share depth, retain visible edges, and do not manufacture readiness", () => {
		const state = mergeLearningContribution(emptyLearningGraphState(), contribution({ prerequisites: [edge("a", "b"), edge("b", "a"), edge("b", "c"), edge("missing", "c"), edge("a", "a")] }));
		const snapshot = buildLearningGraphSnapshot([node("a"), node("b"), node("c")], state);
		assert.deepEqual(snapshot.cycles, [["a", "b"]]);
		assert.deepEqual(snapshot.nodes.map((node) => node.depth), [0, 0, 1]);
		assert.ok(snapshot.nodes.every((node) => !node.ready));
		assert.equal(snapshot.prerequisites.length, 3);
	});

	it("group unlocks expose remaining external blockers and preserve exact dependencies", () => {
		const input = [node("a"), node("b"), node("c"), node("d")];
		let state = mergeLearningContribution(emptyLearningGraphState(), contribution({ prerequisites: [edge("a", "c"), edge("b", "c"), edge("a", "d")], groups: [{ id: "g_a", name: "Foundations", description: "", members: ["a"] }, { id: "g_c", name: "Later", description: "", members: ["c", "d"] }] }));
		let snapshot = buildLearningGraphSnapshot(input, state);
		assert.deepEqual(snapshot.groups[0]!.unlocks, ["d"], "c still needs b outside this group");
		assert.equal(snapshot.groupEdges[0]!.prerequisiteIds.length, 2);
		assert.deepEqual(snapshot.groups[1]!.counts, { unassessed: 2, learning: 0, comfortable: 0 });
		state = progress(state, "b", "comfortable");
		snapshot = buildLearningGraphSnapshot(input, state);
		assert.deepEqual(snapshot.groups[0]!.unlocks, ["c", "d"]);
		assert.deepEqual(snapshot.groups.map((group) => group.depth), [0, 1]);
	});

	it("future concepts become encountered only with provenance, and keep their creation date", () => {
		let state = mergeLearningContribution(emptyLearningGraphState(), contribution({ futureNodes: [{ ...node("n_future_a"), provenance: [] }] }));
		let snapshot = buildLearningGraphSnapshot([], state);
		assert.equal(snapshot.nodes[0]!.future, true);
		assert.equal(snapshot.nodes[0]!.firstEncounteredAt, null);
		state = mergeLearningContribution(state, contribution({ futureNodes: [{ ...node("n_future_a"), createdAt: "2026-10-29T12:00:00.000Z" }] }));
		snapshot = buildLearningGraphSnapshot([], state, { n_future_a: "2026-10-27T12:00:00.000Z" });
		assert.equal(snapshot.nodes[0]!.future, false);
		assert.equal(snapshot.nodes[0]!.createdAt, date);
		assert.equal(snapshot.nodes[0]!.firstEncounteredAt, "2026-10-27T12:00:00.000Z");
		assert.equal(snapshot.nodes[0]!.progress, "unassessed");
	});

	it("exact statement reconciliation carries corrections and avoids name-only merges", () => {
		const planned = { ...node("n_future_a", "Energy is conserved."), name: "Energy", provenance: [] };
		let state = mergeLearningContribution(emptyLearningGraphState(), contribution({ futureNodes: [planned], prerequisites: [edge("n_future_a", "b")] }));
		state = patchLearningNode(state, planned.id, { name: "My energy", progress: "comfortable" });
		state = patchLearningPrerequisite(state, { from: planned.id, to: "b", enabled: false });
		const input = [{ ...node("n_real", "Energy is conserved."), name: "Energy" }, node("b")];
		state = reconcileLearningGraphState(input, state);
		let snapshot = buildLearningGraphSnapshot(input, state);
		assert.equal(snapshot.nodes.length, 2);
		assert.equal(snapshot.idAliases?.n_future_a, "n_real");
		assert.equal(snapshot.nodes.find((node) => node.id === "n_real")!.name, "My energy");
		assert.equal(snapshot.prerequisiteCorrections[0]!.from, "n_real");
		assert.equal(snapshot.prerequisites.length, 0);
		state = patchLearningNode(state, "n_real", { progress: null });
		assert.equal(buildLearningGraphSnapshot(input, state).nodes.find((node) => node.id === "n_real")!.progress, "unassessed");
		const distinct = contribution({ futureNodes: [{ ...planned, statement: "Energy is a scalar." }] });
		snapshot = buildLearningGraphSnapshot(input, mergeLearningContribution(emptyLearningGraphState(), distinct));
		assert.equal(snapshot.nodes.length, 3, "same short label must not merge different propositions");
	});

	it("cross-source encounter refreshes preserve original creation date and do not bake in a manual title", () => {
		const original = { ...node("n_future_a", "A future proposition"), name: "Automatic name", provenance: [] };
		let state = mergeLearningContribution(emptyLearningGraphState(), contribution({ futureNodes: [original] }));
		state = patchLearningNode(state, original.id, { name: "User name" });
		state = mergeLearningContribution(state, contribution({ sourceId: "chat_b", updatedAt: "2026-10-29T12:00:00.000Z", futureNodes: [{ ...original, name: "User name", createdAt: "2026-10-29T12:00:00.000Z", provenance: [{ chatId: "chat_b", messageId: "intro" }] }] }));
		state = mergeLearningContribution(state, contribution({ updatedAt: "2026-10-30T12:00:00.000Z" }));
		let effective = buildLearningGraphSnapshot([], state).nodes[0]!;
		assert.equal(effective.createdAt, date);
		assert.equal(effective.name, "User name");
		state = patchLearningNode(state, original.id, { name: null });
		effective = buildLearningGraphSnapshot([], state).nodes[0]!;
		assert.equal(effective.name, "Automatic name");
		assert.equal(effective.createdAt, date);
		assert.equal(effective.future, false);
	});

	it("deletion removes identity metadata and stale automatic batches cannot resurrect it", () => {
		const automatic = contribution({ futureNodes: [{ ...node("n_future_a"), provenance: [] }], prerequisites: [edge("n_future_a", "b")] });
		let state = mergeLearningContribution(emptyLearningGraphState(), automatic);
		state = patchLearningNode(state, "n_future_a", { name: "My name" });
		state = removeLearningNode(state, "n_future_a");
		state = mergeLearningContribution(state, automatic);
		const snapshot = buildLearningGraphSnapshot([node("b")], state);
		assert.deepEqual(snapshot.nodes.map((node) => node.id), ["b"]);
		assert.deepEqual(snapshot.prerequisites, []);
		assert.equal(state.nodeOverrides.n_future_a, undefined);
	});

	it("source deletion removes automatic evidence but preserves deliberate user annotations", () => {
		let state = mergeLearningContribution(emptyLearningGraphState(), contribution({ nodes: [{ nodeId: "a", progressEvidence: [{ state: "comfortable", explanation: "Solved it", provenance, observedAt: date }] }] }));
		state = patchLearningNode(state, "a", { name: "Kept name", progress: "learning" });
		state = removeLearningSource(state, "chat_a");
		const effective = buildLearningGraphSnapshot([node("a")], state).nodes[0]!;
		assert.equal(effective.name, "Kept name");
		assert.equal(effective.progress, "learning");
		assert.equal(effective.automaticProgress, "unassessed");
	});

	it("symbol search recognizes notation, LaTeX, names, and meaning without global identity merges", () => {
		const state = patchLearningNode(emptyLearningGraphState(), "a", { symbols: [{ notation: "γ", meaning: "Exponential growth factor", aliases: [], provenance: [] }], tags: ["dynamics"] });
		const target = buildLearningGraphSnapshot([node("a")], state).nodes[0]!;
		for (const query of ["γ", "\\gamma", "gamma", "growth factor", "dynamics"]) assert.equal(matchesLearningConcept(target, query), true, query);
		assert.equal(matchesLearningConcept(target, "angular momentum"), false);
	});
});

describe("learning metadata storage boundaries", () => {
	it("validates identity-preserving patches and explicit resets", () => {
		assert.deepEqual(parseLearningNodePatch({ name: " New label ", progress: null }), { name: "New label", progress: null });
		assert.throws(() => parseLearningNodePatch({ name: " " }));
		assert.throws(() => parseLearningNodePatch({ statement: "Change identity" }));
		assert.throws(() => parseLearningNodePatch({ createdAt: date }));
		assert.throws(() => parseLearningNodePatch({ symbols: [{ notation: "γ", meaning: "" }] }));
		assert.deepEqual(parseLearningPrerequisitePatch({ from: "a", to: "b", enabled: null }), { from: "a", to: "b", enabled: null });
	});

	it("round-trips automatic evidence and manual overrides and refuses corrupt/newer data", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "learning-graph-"));
		const file = path.join(directory, "learning.json");
		const store = createLearningGraphStore(file);
		try {
			assert.deepEqual(store.read(), emptyLearningGraphState());
			let state = mergeLearningContribution(store.read(), contribution({ fingerprint: "full", messageFingerprints: { message_1: "one" }, nodes: [{ nodeId: "a", tags: ["physics"] }] }));
			state = patchLearningNode(state, "a", { name: "My label", progress: "comfortable" });
			store.write(state);
			assert.deepEqual(store.read(), state);
			state = mergeLearningContribution(store.read(), contribution({ messageFingerprints: { message_2: "two" } }));
			assert.deepEqual(state.contributions.chat_a!.messageFingerprints, { message_1: "one", message_2: "two" });
			assert.equal(state.contributions.chat_a!.fingerprint, "full");
			fs.writeFileSync(file, "broken-json");
			assert.throws(() => store.read());
			assert.equal(fs.readFileSync(file, "utf8"), "broken-json");
			fs.writeFileSync(file, JSON.stringify({ ...state, version: 2 }));
			assert.throws(() => store.read());
		} finally { fs.rmSync(directory, { recursive: true, force: true }); }
	});
});
