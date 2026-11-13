import assert from "node:assert/strict";
import { it } from "node:test";
import type { LearningGraphSnapshot, LearningPrerequisite } from "../src/core/contracts/learning-graph.ts";
import { learningDescendantFocusIds, learningFocus, learningFocusLevel } from "../src/core/learning-focus.ts";
import { buildLearningGraphSnapshot, learningPrerequisiteId } from "../src/core/learning-graph.ts";

const prerequisite = ([from, to]: readonly [string, string]): LearningPrerequisite => ({
	id: learningPrerequisiteId(from, to), from, to, origin: "automatic", explanation: "Recorded prerequisite", provenance: [],
});

function graph(ids: string[], edges: readonly (readonly [string, string])[]): LearningGraphSnapshot {
	const snapshot = buildLearningGraphSnapshot(ids.map((id) => ({
		id, name: id, statement: id, aliases: [], createdAt: "2026-10-20T12:00:00.000Z", provenance: [],
	})));
	return { ...snapshot, prerequisites: edges.map(prerequisite) };
}

it("shows shortest prerequisite layers and includes all shortest routes without incidental edges", () => {
	const input = graph(["goal", "a", "b", "c", "d", "deep", "unrelated"], [
		["a", "goal"], ["b", "goal"], ["c", "a"], ["c", "b"], ["d", "a"], ["deep", "c"],
		["a", "b"], ["a", "c"], ["c", "d"], ["c", "a"],
	]);
	const focus = learningFocus(input, "goal", "prerequisites");
	assert.deepEqual(focus.levels, [["goal"], ["a", "b"], ["c", "d"], ["deep"]]);
	assert.deepEqual(focus.towardAnchor.get("c"), ["a", "b"]);
	assert.deepEqual(learningFocusLevel(focus, 2, false), {
		levelIds: ["c", "d"], pathIds: new Set(), pathEdgeIds: new Set(),
	});

	const { levelIds, pathIds, pathEdgeIds } = learningFocusLevel(focus, 2, true);
	assert.deepEqual(pathIds, new Set(["a", "b", "goal"]));
	assert.deepEqual(pathEdgeIds, new Set([
		learningPrerequisiteId("a", "goal"), learningPrerequisiteId("b", "goal"),
		learningPrerequisiteId("c", "a"), learningPrerequisiteId("c", "b"), learningPrerequisiteId("d", "a"),
	]));
	const levelSet = new Set(levelIds);
	const visibleEdges = input.prerequisites.filter(({ id, from, to }) =>
		pathEdgeIds.has(id) || (levelSet.has(from) && levelSet.has(to)));
	assert.deepEqual(new Set(visibleEdges.map(({ id }) => id)), new Set([...pathEdgeIds, learningPrerequisiteId("c", "d")]));
});

it("traverses outgoing unlocks and preserves the recorded edge orientation", () => {
	const input = graph(["anchor", "left", "right", "target", "earlier"], [
		["anchor", "left"], ["anchor", "right"], ["left", "target"], ["right", "target"], ["earlier", "anchor"],
		["target", "anchor"], ["left", "right"],
	]);
	const focus = learningFocus(input, "anchor", "unlocks");
	assert.deepEqual(focus.levels, [["anchor"], ["left", "right"], ["target"]]);
	assert.deepEqual(learningFocusLevel(focus, 2, true), {
		levelIds: ["target"],
		pathIds: new Set(["left", "right", "anchor"]),
		pathEdgeIds: new Set([
			learningPrerequisiteId("anchor", "left"), learningPrerequisiteId("anchor", "right"),
			learningPrerequisiteId("left", "target"), learningPrerequisiteId("right", "target"),
		]),
	});
});

it("uses canonical concept IDs and excludes missing endpoints, loops and missing anchors", () => {
	const input = graph(["anchor", "direct"], [
		["direct", "anchor"], ["old_direct", "old_anchor"], ["outside", "anchor"], ["anchor", "old_anchor"],
	]);
	input.idAliases = { old_anchor: "anchor", old_direct: "direct" };
	const focus = learningFocus(input, "old_anchor", "prerequisites");
	assert.deepEqual(focus.levels, [["anchor"], ["direct"]]);
	assert.deepEqual([...focus.towardAnchor], [["direct", ["anchor"]]]);
	assert.deepEqual(learningFocusLevel(focus, 0, true), {
		levelIds: ["anchor"], pathIds: new Set(), pathEdgeIds: new Set(),
	});
	const missing = learningFocus(input, "outside", "prerequisites");
	assert.deepEqual(missing.levels, []);
	assert.deepEqual(learningFocusLevel(missing, 0, true), {
		levelIds: [], pathIds: new Set(), pathEdgeIds: new Set(),
	});
});

it("keeps every descendant and its immediate parents without expanding the added parents", () => {
	const input = graph([
		"anchor", "direct", "deep", "later", "co_parent", "other_parent",
		"ancestor", "sibling", "anchor_parent", "unrelated",
	], [
		["anchor", "direct"], ["direct", "deep"], ["deep", "later"],
		["co_parent", "direct"], ["other_parent", "deep"], ["ancestor", "co_parent"],
		["co_parent", "sibling"], ["anchor_parent", "anchor"],
	]);
	assert.deepEqual(learningDescendantFocusIds(input, "anchor"),
		new Set(["direct", "deep", "later", "co_parent", "other_parent"]));
	assert.deepEqual(learningDescendantFocusIds(input, "later"), new Set());
});

it("excludes the anchor in cycles and ignores unavailable endpoints in canvas focus", () => {
	const input = graph(["anchor", "direct", "deep", "co_parent", "out_of_reach"], [
		["old_anchor", "old_direct"], ["anchor", "direct"], ["direct", "deep"],
		["deep", "old_anchor"], ["direct", "old_direct"], ["co_parent", "old_direct"],
		["anchor", "missing"], ["missing", "out_of_reach"], ["missing_parent", "deep"],
	]);
	input.idAliases = { old_anchor: "anchor", old_direct: "direct" };
	assert.deepEqual(learningDescendantFocusIds(input, "old_anchor"), new Set(["direct", "deep", "co_parent"]));
	assert.deepEqual(learningDescendantFocusIds(input, "missing"), new Set());
});
