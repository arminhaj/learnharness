import assert from "node:assert/strict";
import { it } from "node:test";
import { createConceptSessionRequest, resolveLearningSessionTarget } from "../src/core/learning-session.ts";
import { buildLearningGraphSnapshot, emptyLearningGraphState, mergeLearningContribution, reconcileLearningGraphState } from "../src/core/learning-graph.ts";
import { problemTool } from "../src/agent/tools/practice.ts";

it("an existing practice session resolves its planned target after a ledger identity appears", async () => {
	const date = "2026-10-20T12:00:00.000Z";
	const planned = { id: "n_future_growth", name: "Growth", statement: "Growth is proportional to amount.", aliases: [], createdAt: date, provenance: [] };
	let state = mergeLearningContribution(emptyLearningGraphState(), { sourceId: "source", updatedAt: date, nodes: [], prerequisites: [], groups: [], futureNodes: [planned] });
	let snapshot = buildLearningGraphSnapshot([], state);
	const request = createConceptSessionRequest(snapshot.nodes[0]!, "practice");
	const tool = problemTool({ problemActive: false }, undefined, (target) => resolveLearningSessionTarget(snapshot, target));
	assert.equal(resolveLearningSessionTarget(snapshot, request.learningContext.nodeId), planned.id);

	const encountered = { ...planned, id: "n_encountered_growth", provenance: [{ chatId: "teaching", messageId: "explanation" }] };
	state = reconcileLearningGraphState([encountered], state);
	snapshot = buildLearningGraphSnapshot([encountered], state);
	assert.equal(snapshot.nodes.length, 1, "aliases must not create fake duplicate concepts");
	const prepared = await tool.prepareArguments!({ statement: "Explain growth across two periods.", mode: "recall", target: [request.learningContext.nodeId], modelSolution: "Apply the factor twice." });
	assert.deepEqual((prepared as { target: string[] }).target, [encountered.id]);
	const result = await tool.execute("problem_call", prepared as never);
	assert.notEqual(result.isError, true);
	assert.equal(resolveLearningSessionTarget(snapshot, "n_missing"), null);
});
