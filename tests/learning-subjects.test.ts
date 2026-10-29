import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphNode, LearningContribution, LearningGraphSnapshot } from "../src/core/contracts.ts";
import { buildLearningGraphSnapshot, emptyLearningGraphState, mergeLearningContribution, normalizeLearningSubjects, patchLearningNode, patchLearningPrerequisite, reconcileLearningGraphState, removeLearningSource } from "../src/core/learning-graph.ts";
import { parseLearningContribution, parseLearningGraphState, parseLearningNodePatch } from "../src/core/learning-graph-validation.ts";
import { LEARNING_SUBJECT_UNASSIGNED_ID, learningSubjectId, learningSubjects, scopeLearningGraphToSubject } from "../src/core/learning-subjects.ts";

const date = "2026-10-29T12:00:00.000Z";
const node = (id: string, name = id): GraphNode => ({ id, name, statement: `Statement ${id}`, aliases: [], createdAt: date, provenance: [] });
const contribution = (patch: Partial<LearningContribution> = {}): LearningContribution => ({ sourceId: "source_a", updatedAt: date, nodes: [], prerequisites: [], groups: [], ...patch });
const edge = (from: string, to: string) => ({ from, to, explanation: `${from} prepares for ${to}`, provenance: [] });

describe("explicit learning subjects", () => {
	it("deduplicates case and whitespace without collapsing C++ into C", () => {
		assert.deepEqual(normalizeLearningSubjects([" C++ ", "c++", " C ", "  Classical   Mechanics ", "classical mechanics", ""]), ["C++", "C", "Classical Mechanics"]);
		assert.equal(learningSubjectId(" C++ "), "subject:c%2B%2B");
		assert.equal(learningSubjectId(" Classical  Mechanics "), learningSubjectId("classical mechanics"));
		assert.notEqual(learningSubjectId("C++"), learningSubjectId("C"));
		assert.notEqual(learningSubjectId("Unassigned"), LEARNING_SUBJECT_UNASSIGNED_ID);
	});

	it("unions explicit automatic labels across batches/sources and preserves empty manual overrides until reset", () => {
		let state = mergeLearningContribution(emptyLearningGraphState(), contribution({ nodes: [{ nodeId: "a", subjects: [" C++ ", "c++"] }] }));
		state = mergeLearningContribution(state, contribution({ nodes: [{ nodeId: "a", subjects: ["Mechanics"] }] }));
		state = mergeLearningContribution(state, contribution({ sourceId: "source_b", nodes: [{ nodeId: "a", subjects: ["mechanics", "Mathematics"] }] }));
		state = patchLearningNode(state, "a", { subjects: [], tags: ["kept"] });
		state = mergeLearningContribution(state, contribution({ nodes: [{ nodeId: "a", subjects: ["Computer Science"] }] }));
		let effective = buildLearningGraphSnapshot([node("a")], state).nodes[0]!;
		assert.deepEqual(effective.subjects, []);
		assert.deepEqual(effective.subjectsOverride, []);
		assert.deepEqual(effective.automaticSubjects, ["C++", "Mechanics", "Computer Science", "Mathematics"]);
		state = patchLearningNode(state, "a", { subjects: [" My   Subject ", "my subject"] });
		effective = buildLearningGraphSnapshot([node("a")], state).nodes[0]!;
		assert.deepEqual(effective.subjects, ["My Subject"]);
		assert.deepEqual(effective.subjectsOverride, ["My Subject"]);
		state = patchLearningNode(state, "a", { subjects: null });
		effective = buildLearningGraphSnapshot([node("a")], state).nodes[0]!;
		assert.deepEqual(effective.subjects, effective.automaticSubjects);
		assert.equal(effective.subjectsOverride, null);
		assert.deepEqual(effective.tags, ["kept"]);
		state = removeLearningSource(state, "source_b");
		assert.deepEqual(buildLearningGraphSnapshot([node("a")], state).nodes[0]!.subjects, ["C++", "Mechanics", "Computer Science"]);
	});

	it("validates new optional metadata while keeping legacy states readable", () => {
		assert.deepEqual(parseLearningNodePatch({ subjects: [" C++ ", "c++", " Classical   Mechanics "] }), { subjects: ["C++", "Classical Mechanics"] });
		assert.deepEqual(parseLearningNodePatch({ subjects: [] }), { subjects: [] });
		assert.deepEqual(parseLearningNodePatch({ subjects: null }), { subjects: null });
		assert.throws(() => parseLearningNodePatch({ subjects: [" "] }));
		assert.throws(() => parseLearningNodePatch({ subjects: ["x".repeat(101)] }));
		assert.throws(() => parseLearningNodePatch({ subjects: Array.from({ length: 101 }, (_, index) => `Subject ${index}`) }));
		assert.deepEqual(parseLearningContribution(contribution({ nodes: [{ nodeId: "a", subjects: [" C++ ", "c++"] }] })).nodes[0]!.subjects, ["C++"]);
		assert.deepEqual(parseLearningContribution(contribution({ groups: [{ id: "g", name: "Group", description: "", members: ["a"], subjects: [" C++ ", "c++"] }] })).groups[0]!.subjects, ["C++"]);
		assert.deepEqual(parseLearningGraphState(emptyLearningGraphState()), emptyLearningGraphState());
		const legacy = buildLearningGraphSnapshot([node("a", "C++ pointers")]).nodes[0]!;
		assert.deepEqual(legacy.subjects, []);
		assert.deepEqual(legacy.automaticSubjects, []);
		assert.equal(legacy.subjectsOverride, null);
	});

	it("preserves explicit group subjects across omitted batches and merges source labels", () => {
		const group = { id: "g", name: "Group", description: "", members: ["a"] };
		let state = mergeLearningContribution(emptyLearningGraphState(), contribution({ groups: [{ ...group, subjects: [" C++ ", "c++"] }] }));
		state = mergeLearningContribution(state, contribution({ groups: [group] }));
		assert.deepEqual(state.contributions.source_a!.groups[0]!.subjects, ["C++"]);
		state = mergeLearningContribution(state, contribution({ sourceId: "source_b", groups: [{ ...group, subjects: ["Mechanics"] }] }));
		assert.deepEqual(buildLearningGraphSnapshot([node("a")], state).groups[0]!.subjects, ["C++", "Mechanics"]);
		assert.equal(buildLearningGraphSnapshot([node("a")], mergeLearningContribution(emptyLearningGraphState(), contribution({ groups: [group] }))).groups[0]!.subjects, undefined);
	});

	it("carries subject evidence and corrections through planned identity reconciliation", () => {
		const planned = node("n_future");
		const stored = { ...planned, id: "n_actual" };
		let state = mergeLearningContribution(emptyLearningGraphState(), contribution({ futureNodes: [planned], nodes: [{ nodeId: planned.id, subjects: ["C++"] }, { nodeId: stored.id, subjects: ["Mechanics"] }] }));
		state = patchLearningNode(state, planned.id, { subjects: [] });
		state = reconcileLearningGraphState([stored], state);
		let snapshot = buildLearningGraphSnapshot([stored], state);
		assert.deepEqual(snapshot.nodes[0]!.automaticSubjects, ["C++", "Mechanics"]);
		assert.deepEqual(snapshot.nodes[0]!.subjects, []);
		assert.deepEqual(scopeLearningGraphToSubject(snapshot, LEARNING_SUBJECT_UNASSIGNED_ID).idAliases, { n_future: "n_actual" });
		state = patchLearningNode(state, planned.id, { subjects: ["Mathematics"] });
		snapshot = buildLearningGraphSnapshot([stored], state);
		assert.deepEqual(snapshot.nodes[0]!.subjects, ["Mathematics"]);
		assert.equal(state.nodeOverrides.n_future, undefined, "alias edits write to the canonical override");
		state = patchLearningNode(state, planned.id, { subjects: null });
		assert.deepEqual(buildLearningGraphSnapshot([stored], state).nodes[0]!.subjects, ["C++", "Mechanics"]);
	});
});

function mixedSnapshot(): LearningGraphSnapshot {
	const ids = ["cpp_a", "cpp_b", "mechanics_a", "mechanics_b", "shared", "solo", "unassigned"];
	let state = mergeLearningContribution(emptyLearningGraphState(), contribution({
		nodes: [
			{ nodeId: "cpp_a", subjects: ["C++"] }, { nodeId: "cpp_b", subjects: ["c++"] },
			{ nodeId: "mechanics_a", subjects: ["Mechanics"] }, { nodeId: "mechanics_b", subjects: ["Mechanics"] },
			{ nodeId: "shared", subjects: ["C++", "Mechanics"] }, { nodeId: "solo", subjects: ["C++"] },
		],
		prerequisites: [edge("mechanics_a", "cpp_a"), edge("cpp_a", "cpp_b"), edge("mechanics_a", "cpp_b"), edge("cpp_a", "mechanics_b"), edge("cpp_b", "shared")],
		groups: [
			{ id: "g_mechanics", name: "Mechanics foundations", description: "", members: ["mechanics_a"] },
			{ id: "g_mixed", name: "Mixed source group", description: "", members: ["cpp_a", "mechanics_a"] },
			{ id: "g_cpp", name: "Later C++", description: "", members: ["cpp_b"] },
			{ id: "g_later", name: "Later mechanics", description: "", members: ["mechanics_b"] },
			{ id: "g_shared", name: "Shared concept", description: "", subjects: ["C++", "Mechanics"], members: ["shared"] },
		],
	}));
	state = patchLearningNode(state, "mechanics_a", { progress: "learning" });
	state = patchLearningPrerequisite(state, { from: "unassigned", to: "cpp_a", enabled: false });
	state = patchLearningPrerequisite(state, { from: "solo", to: "cpp_b", enabled: false });
	return buildLearningGraphSnapshot(ids.map((id) => node(id)), state);
}

describe("subject-scoped curriculum projections", () => {
	it("lists stable explicit subjects, shared memberships, and unassigned/ungrouped concepts without an All bucket", () => {
		const snapshot = mixedSnapshot();
		const subjects = learningSubjects(snapshot);
		assert.deepEqual(subjects.map(({ id, name }) => ({ id, name })), [{ id: "subject:c%2B%2B", name: "C++" }, { id: "subject:mechanics", name: "Mechanics" }, { id: "unassigned", name: "Unassigned" }]);
		assert.deepEqual(subjects[0]!.nodeIds, ["cpp_a", "cpp_b", "shared", "solo"]);
		assert.deepEqual(subjects[1]!.nodeIds, ["mechanics_a", "mechanics_b", "shared"]);
		assert.deepEqual(subjects[2]!.nodeIds, ["unassigned"]);
		assert.deepEqual(learningSubjects({ nodes: [] }), []);
	});

	it("excludes mixed legacy groups and filters derived lists while preserving real external blockers", () => {
		const snapshot = mixedSnapshot();
		const before = JSON.stringify(snapshot);
		const scoped = scopeLearningGraphToSubject(snapshot, learningSubjectId("C++"));
		assert.deepEqual(scoped.nodes.map((node) => node.id), ["cpp_a", "cpp_b", "shared", "solo"]);
		assert.deepEqual(scoped.groups.map((group) => group.id), ["g_cpp", "g_shared"]);
		assert.deepEqual(scoped.groups.map((group) => group.depth), [0, 1]);
		assert.equal(snapshot.groups.find((group) => group.id === "g_mixed")!.depth, 1);
		assert.ok(!scoped.groups.some((group) => group.members.includes("cpp_a")), "ambiguous mixed group members remain available as ungrouped concepts");
		const later = scoped.groups.find((group) => group.id === "g_cpp")!;
		assert.deepEqual(later.counts, { unassessed: 1, learning: 0, comfortable: 0 });
		assert.deepEqual(later.readyNodeIds, []);
		assert.deepEqual(later.blockedNodeIds, ["cpp_b"]);
		assert.deepEqual(scoped.groups.find((group) => group.id === "g_cpp")!.unlocks, ["shared"]);
		assert.equal(scoped.nodes.find((node) => node.id === "cpp_a")!.ready, false);
		assert.deepEqual(scoped.nodes.find((node) => node.id === "cpp_a")!.unmetPrerequisiteIds, ["mechanics_a"]);
		assert.deepEqual(scoped.prerequisiteCorrections.map((edge) => [edge.from, edge.to]), [["solo", "cpp_b"]]);
		const included = new Set(scoped.nodes.map((node) => node.id));
		const groupIds = new Set(scoped.groups.map((group) => group.id));
		const edgeIds = new Set(scoped.prerequisites.map((edge) => edge.id));
		assert.ok(scoped.prerequisites.every((edge) => included.has(edge.from) && included.has(edge.to)));
		assert.ok(scoped.groupEdges.every((edge) => groupIds.has(edge.from) && groupIds.has(edge.to) && edge.prerequisiteIds.every((id) => edgeIds.has(id))));
		assert.ok(scoped.groups.every((group) => [...group.members, ...group.readyNodeIds, ...group.blockedNodeIds, ...group.unlocks].every((id) => included.has(id))));
		assert.equal(JSON.stringify(snapshot), before, "scoping must not mutate the global snapshot");
	});

	it("omits all-node legacy groups with no common subject without hiding their concepts", () => {
		const snapshot = mixedSnapshot();
		snapshot.groups.push({ id: "g_all", name: "Global legacy group", description: "", members: snapshot.nodes.map((node) => node.id), depth: 0, counts: { unassessed: 99, learning: 99, comfortable: 99 }, readyNodeIds: ["unassigned"], blockedNodeIds: ["mechanics_a"], unlocks: ["mechanics_b"] });
		const scoped = scopeLearningGraphToSubject(snapshot, learningSubjectId("C++"));
		assert.equal(scoped.groups.some((group) => group.id === "g_all"), false);
		assert.deepEqual(scoped.nodes.map((node) => node.id), ["cpp_a", "cpp_b", "shared", "solo"]);
	});

	it("keeps domain group titles separate when their only member is a shared foundation", () => {
		const state = mergeLearningContribution(emptyLearningGraphState(), contribution({
			nodes: [{ nodeId: "shared", subjects: ["C++", "Mechanics"] }],
			groups: [
				{ id: "g_cpp", name: "C++ foundations", description: "Programming context", subjects: ["C++"], members: ["shared"] },
				{ id: "g_mechanics", name: "Mechanics foundations", description: "Physics context", subjects: ["Mechanics"], members: ["shared"] },
				{ id: "g_ambiguous_legacy", name: "Legacy domain cannot be inferred", description: "Could belong to either domain", members: ["shared"] },
			],
		}));
		const global = buildLearningGraphSnapshot([node("shared")], state);
		const cpp = scopeLearningGraphToSubject(global, learningSubjectId("C++"));
		const mechanics = scopeLearningGraphToSubject(global, learningSubjectId("Mechanics"));
		assert.deepEqual(cpp.groups.map((group) => group.name), ["C++ foundations"]);
		assert.deepEqual(mechanics.groups.map((group) => group.name), ["Mechanics foundations"]);
		assert.equal(cpp.groups[0]!.description, "Programming context");
		assert.equal(mechanics.groups[0]!.description, "Physics context");
		assert.deepEqual(cpp.nodes.map((node) => node.id), ["shared"]);
		assert.deepEqual(mechanics.nodes.map((node) => node.id), ["shared"]);
	});

	it("uses classified-member intersection for legacy groups and keeps unassigned groups only without explicit subjects", () => {
		const state = mergeLearningContribution(emptyLearningGraphState(), contribution({
			nodes: [{ nodeId: "shared", subjects: ["C++", "Mechanics"] }, { nodeId: "cpp", subjects: ["C++"] }],
			groups: [
				{ id: "g_legacy", name: "C++ group", description: "", members: ["shared", "cpp", "unassigned"] },
				{ id: "g_unassigned", name: "Unassigned group", description: "", members: ["unassigned"] },
				{ id: "g_explicit", name: "Mechanics group", description: "", subjects: ["Mechanics"], members: ["unassigned"] },
				{ id: "g_empty", name: "Explicitly unassigned", description: "", subjects: [], members: ["unassigned"] },
			],
		}));
		const global = buildLearningGraphSnapshot(["shared", "cpp", "unassigned"].map((id) => node(id)), state);
		const cpp = scopeLearningGraphToSubject(global, learningSubjectId("C++"));
		assert.deepEqual(cpp.groups.map((group) => group.id), ["g_legacy"]);
		assert.deepEqual(cpp.groups[0]!.members, ["shared", "cpp"]);
		assert.deepEqual(scopeLearningGraphToSubject(global, learningSubjectId("Mechanics")).groups, []);
		assert.deepEqual(scopeLearningGraphToSubject(global, LEARNING_SUBJECT_UNASSIGNED_ID).groups.map((group) => group.id), ["g_unassigned", "g_empty"]);
	});

	it("recomputes cycles after filtering instead of inventing partial cycles", () => {
		const state = mergeLearningContribution(emptyLearningGraphState(), contribution({ nodes: [{ nodeId: "a", subjects: ["C++"] }, { nodeId: "b", subjects: ["Mechanics"] }, { nodeId: "c", subjects: ["C++"] }, { nodeId: "d", subjects: ["C++"] }], prerequisites: [edge("a", "b"), edge("b", "a"), edge("c", "d"), edge("d", "c")] }));
		const scoped = scopeLearningGraphToSubject(buildLearningGraphSnapshot(["a", "b", "c", "d"].map((id) => node(id)), state), learningSubjectId("C++"));
		assert.deepEqual(scoped.cycles, [["c", "d"]]);
		assert.equal(scoped.nodes.find((node) => node.id === "a")!.ready, false);
		assert.deepEqual(scoped.nodes.find((node) => node.id === "a")!.unmetPrerequisiteIds, ["b"]);
	});

	it("returns empty projections for an unknown subject and preserves unassigned nodes without inventing groups", () => {
		const snapshot = mixedSnapshot();
		assert.deepEqual(scopeLearningGraphToSubject(snapshot, "subject:unknown"), { nodes: [], prerequisites: [], prerequisiteCorrections: [], groups: [], groupEdges: [], cycles: [] });
		const unassigned = scopeLearningGraphToSubject(snapshot, LEARNING_SUBJECT_UNASSIGNED_ID);
		assert.deepEqual(unassigned.nodes.map((node) => node.id), ["unassigned"]);
		assert.deepEqual(unassigned.groups, []);
		assert.deepEqual(learningSubjects(buildLearningGraphSnapshot([])), []);
	});
});
