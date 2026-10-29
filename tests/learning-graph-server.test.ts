import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { GraphNode, LearningContribution } from "../src/core/contracts.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learning-server-"));
process.env.LH_DATA_DIR = directory;
const date = "2026-10-28T12:00:00.000Z";
let service: typeof import("../src/server/learning-graph.ts");
let stores: typeof import("../src/server/stores.ts")["stores"];
let deleteGraphNode: typeof import("../src/server/graph.ts")["deleteGraphNode"];
const node = (id: string, statement = id): GraphNode => ({ id, name: id, statement, createdAt: date, aliases: [], provenance: [] });
const contribution = (patch: Partial<LearningContribution> = {}): LearningContribution => ({ sourceId: "source_a", updatedAt: date, nodes: [], prerequisites: [], groups: [], ...patch });

before(async () => {
	service = await import("../src/server/learning-graph.ts");
	({ stores } = await import("../src/server/stores.ts"));
	({ deleteGraphNode } = await import("../src/server/graph.ts"));
	for (const id of ["n_a", "n_b", "n_c"]) stores.graphStore.appendNode(node(id));
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("learning graph server mutations", () => {
	it("saves metadata in its sidecar, preserves evidence bytes, and keeps manual progress above later automatic evidence", () => {
		const file = path.join(directory, "graph", "nodes.jsonl");
		const before = fs.readFileSync(file, "utf8");
		const renamed = service.updateLearningNode("n_a", { name: "Named by me", progress: "comfortable", symbols: [{ notation: "γ", meaning: "Growth factor", aliases: ["gamma"], provenance: [] }] });
		assert.equal(renamed.ok, true);
		if (!renamed.ok) return;
		assert.ok(renamed.graphRevision > 0);
		assert.equal(renamed.learning.nodes.find((node) => node.id === "n_a")!.name, "Named by me");
		service.saveLearningContribution(contribution({ nodes: [{ nodeId: "n_a", progressEvidence: [{ state: "learning", explanation: "An answer required a hint", provenance: [{ chatId: "source_a", messageId: "answer_a" }], observedAt: date }] }] }));
		const effective = service.learningGraphView().nodes.find((node) => node.id === "n_a")!;
		assert.equal(effective.progress, "comfortable");
		assert.equal(effective.automaticProgress, "learning");
		assert.equal(effective.createdAt, date);
		assert.equal(fs.readFileSync(file, "utf8"), before);
		assert.equal(service.updateLearningNode("n_a", { createdAt: "wrong" }).ok, false);
		assert.equal(service.updateLearningNode("n_missing", { name: "missing" }).ok, false);
	});

	it("manual prerequisite suppression persists; reset restores evidence; a new cycle is refused", () => {
		const automatic = contribution({ prerequisites: [{ from: "n_a", to: "n_b", explanation: "Preparation", provenance: [] }, { from: "n_b", to: "n_c", explanation: "Preparation", provenance: [] }] });
		service.saveLearningContribution(automatic);
		assert.equal(service.updateLearningPrerequisite({ from: "n_a", to: "n_b", enabled: false }).ok, true);
		service.saveLearningContribution(automatic);
		assert.equal(service.learningGraphView().prerequisites.some((edge) => edge.from === "n_a"), false);
		assert.equal(service.updateLearningPrerequisite({ from: "n_a", to: "n_b", enabled: null }).ok, true);
		const cycle = service.updateLearningPrerequisite({ from: "n_c", to: "n_a", enabled: true });
		assert.equal(cycle.ok, false);
		if (!cycle.ok) assert.equal(cycle.code, "prerequisite_cycle");
		assert.equal(service.learningGraphView().prerequisites.length, 2);
	});

	it("a renamed future concept reconciles with its positions and deletion cannot resurrect its old id", async () => {
		service.saveLearningContribution(contribution({ futureNodes: [node("n_future_energy", "Energy is conserved.")] }));
		assert.equal(service.updateLearningNode("n_future_energy", { name: "My energy" }).ok, true);
		const { writeLearningPositions } = await import("../src/store/learning-positions.ts");
		const { commitPositions } = await import("../src/server/commit-positions.ts");
		writeLearningPositions({ n_future_energy: { x: 12, y: 34 } });
		stores.graphStore.appendNode(node("n_energy", "Energy is conserved."));
		let learning = service.learningGraphView();
		assert.ok(!learning.nodes.some((node) => node.id === "n_future_energy"));
		assert.equal(learning.nodes.find((node) => node.id === "n_energy")!.name, "My energy");
		assert.deepEqual(service.effectiveGraphView().positions?.n_energy, { x: 12, y: 34 });
		assert.deepEqual(commitPositions({ n_future_energy: { x: 45, y: 67 } }).n_energy, { x: 45, y: 67 }, "a pending drag from the old identity is retained");
		const outcome = deleteGraphNode("n_energy");
		assert.equal(outcome.ok, true);
		learning = service.learningGraphView();
		assert.ok(!learning.nodes.some((node) => node.id === "n_energy" || node.id === "n_future_energy"));
		assert.ok(!stores.graphStore.readNodes().some((node) => node.id === "n_energy"));
	});

	it("a curriculum-only future node supports deletion without writing an evidence record", () => {
		service.saveLearningContribution(contribution({ futureNodes: [node("n_future_only")] }));
		assert.equal(deleteGraphNode("n_future_only").ok, true);
		assert.equal(deleteGraphNode("n_future_only").ok, false);
		assert.ok(!service.learningGraphView().nodes.some((node) => node.id === "n_future_only"));
	});

	it("deleting the teaching source retains a concept referenced by a learning-only practice source", async () => {
		const teaching = stores.chatStore.createChat("Teaching");
		const practice = stores.chatStore.createChat("Practice");
		stores.graphStore.appendNode({ ...node("n_shared"), provenance: [{ chatId: teaching.id, messageId: "teacher_message" }] });
		service.saveLearningContribution(contribution({ sourceId: teaching.id, nodes: [{ nodeId: "n_shared", tags: ["initial source"] }] }));
		service.saveLearningContribution(contribution({ sourceId: practice.id, nodes: [{ nodeId: "n_shared", progressEvidence: [{ state: "comfortable", explanation: "Independent explanation", observedAt: date, provenance: [{ chatId: practice.id, messageId: "practice_answer" }] }] }] }));
		service.updateLearningNode("n_shared", { name: "My shared concept" });
		const { deleteChatSession } = await import("../src/server/chats.ts");
		const outcome = await deleteChatSession(teaching.id, "delete-nodes");
		assert.equal(outcome.ok, true);
		if (outcome.ok) assert.equal(outcome.stats.nodesRemoved, 0, "a concept retained by practice is not reported as deleted");
		const retained = service.learningGraphView().nodes.find((node) => node.id === "n_shared");
		assert.ok(retained, "surviving practice provenance keeps the concept alive");
		assert.equal(retained.name, "My shared concept");
		assert.equal(retained.progress, "comfortable");
		assert.equal(retained.future, false);
		assert.ok(retained.provenance.some((point) => point.chatId === practice.id));
		assert.ok(retained.provenance.every((point) => point.chatId !== teaching.id));
		assert.equal(service.readLearningGraphState().contributions[teaching.id], undefined);
	});
});
