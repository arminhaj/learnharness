import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord, ChatSummary, CoverageEntry, GraphChain, GraphNode, Position, SessionCheckpoint, SessionFindings } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { deleteChatTraces } from "../src/core/graph-deletion.ts";
import { getGraph, graphSessionIndex, graphSessionPropositions, graphSnapshot, mergeFindings } from "../src/core/graph.ts";
import { attachImpToCommunities, birthSessionOf, birthSessionPartition, impClusterKey } from "../src/core/session-clusters.ts";
import { propositionSessionHref } from "../src/core/session-navigation.ts";

const DATE = "2026-10-25T00:00:00.000Z";
function chat(id: string, exploration?: ChatRecord["exploration"]): ChatRecord {
	return { id, title: id === "original" ? "Django" : "Django exploration", createdAt: DATE, updatedAt: DATE, messages: [], ...(exploration ? { exploration } : {}) };
}
function memory() {
	let nodes: GraphNode[] = [];
	let chains: GraphChain[] = [];
	let coverage: CoverageEntry[] = [];
	let checkpoints: SessionCheckpoint[] = [];
	let positions: Record<string, Position> = {};
	const chats = new Map<string, ChatRecord>();
	const graphStore = {
		readNodes: () => nodes,
		appendNode: (node: GraphNode) => { nodes.push(node); },
		readChains: () => chains,
		appendChain: (chain: GraphChain) => { chains.push(chain); },
		readCoverage: () => coverage,
		appendCoverage: (entry: CoverageEntry) => { coverage.push(entry); },
		readCheckpoints: () => checkpoints,
		appendCheckpoint: (entry: SessionCheckpoint) => { checkpoints.push(entry); },
		readPositions: () => positions,
		writePositions: (next: Record<string, Position>) => { positions = next; },
		readSources: () => [],
		upsertSource: () => {},
		appendSourceUsage: () => {},
		rewriteLedgers: (next: Parameters<GraphStore["rewriteLedgers"]>[0]) => {
			if (next.nodes) nodes = next.nodes;
			if (next.chains) chains = next.chains;
			if (next.coverage) coverage = next.coverage;
			if (next.checkpoints) checkpoints = next.checkpoints;
		},
	} as GraphStore;
	const chatStore = {
		getChat: (id: string) => chats.get(id) ?? null,
		listChats: () => [...chats.values()].map((record) => ({ ...record, kind: "teach", messageCount: 0, phase: "probe", pendingQuestion: false, pendingProblem: false }) as ChatSummary),
	} as ChatStore;
	return { chats, deps: { chatStore, graphStore } };
}
function findings(prefix: string): SessionFindings {
	return {
		propositions: ["A", "B", "C"].map((id) => ({ id, name: `${prefix} ${id}`, statement: `${prefix} statement ${id}`, aliases: [], messageId: `${prefix}-passage` })),
		chains: [{ premises: ["A", "B"], conclusion: "C" }],
	};
}
function populated() {
	const result = memory();
	result.chats.set("original", chat("original"));
	result.chats.set("linked", chat("linked", { parentChatId: "original", sourceMessageId: "lesson-source", parentTitle: "Django", topic: "Examples", status: "active" }));
	mergeFindings("original", findings("first"), { links: [] }, result.deps, { foldedAt: DATE });
	mergeFindings("linked", findings("second"), { links: [] }, result.deps, { foldedAt: DATE, subjectId: "original" });
	return result;
}

describe("inline exploration subjects in the knowledge graph", () => {
	it("links an exploration passage directly into its parent with the exact child message anchor", () => {
		const node = { provenance: [{ chatId: "child /id", messageId: "passage /id", subjectId: "parent /id" }] };
		assert.equal(propositionSessionHref(node, "child /id"), "/chat/parent%20%2Fid?exploration=child%20%2Fid#message-passage%20%2Fid");
		assert.equal(propositionSessionHref({ provenance: [{ chatId: "child", messageId: "", subjectId: "parent" }] }, "child"), "/chat/parent?exploration=child");
	});
	it("merges exploration knowledge into the original subject while retaining actual source anchors", () => {
		const { deps } = populated();
		const graph = getGraph(deps.graphStore);
		const fresh = graph.nodes.filter((node) => node.provenance[0]?.chatId === "linked");
		assert.equal(fresh.length, 3);
		for (const node of fresh) {
			assert.deepEqual(node.provenance, [{ chatId: "linked", messageId: "second-passage", subjectId: "original" }]);
			assert.equal(birthSessionOf(node), "original");
		}
		assert.deepEqual(graph.chains[1]!.provenance, [{ chatId: "linked", messageId: "", subjectId: "original" }]);
		const snapshot = graphSnapshot(deps);
		assert.equal(snapshot.clusters.length, 1);
		assert.equal(snapshot.clusters[0]!.id, "original");
		assert.equal(snapshot.clusters[0]!.label, "Django");
		assert.equal(snapshot.clusters[0]!.members.length, 8, "six propositions and two implication nodes share the subject");
		assert.deepEqual(snapshot.nodeSessions[fresh[0]!.id], ["linked"], "navigation targets the actual new transcript");
		assert.equal(snapshot.sessions.linked, "Django exploration");
	});

	it("presents one subject to graph tools, including direct lookups through an exploration", () => {
		const { deps, chats } = populated();
		chats.get("linked")!.updatedAt = "2026-10-26T00:00:00.000Z";
		const index = graphSessionIndex(deps);
		assert.equal(index.length, 1);
		assert.equal(index[0]!.id, "original");
		assert.equal(index[0]!.propositions, 6);
		assert.equal(index[0]!.updatedAt, "2026-10-26T00:00:00.000Z");
		assert.deepEqual(graphSessionPropositions(deps, "linked"), graphSessionPropositions(deps, "original"));
	});

	it("keeps grouping when transcripts are removed with preserve-graph", () => {
		const { deps, chats } = populated();
		deleteChatTraces(deps.graphStore, "original", "preserve-graph");
		chats.delete("original");
		let snapshot = graphSnapshot(deps);
		assert.equal(snapshot.clusters[0]!.label, "Django", "a live linked session retains the subject label");
		assert.equal(snapshot.sessions.original, undefined, "the deleted transcript is not a navigation target");
		assert.equal(graphSessionIndex(deps)[0]!.kind, "chat");
		deleteChatTraces(deps.graphStore, "linked", "preserve-graph");
		chats.delete("linked");
		snapshot = graphSnapshot(deps);
		assert.equal(snapshot.clusters.length, 1);
		assert.equal(snapshot.clusters[0]!.id, "original");
		assert.equal(snapshot.clusters[0]!.label, null, "no invented label when every source record is gone");
		assert.equal(snapshot.propositions.length, 6);
	});

	it("deletes an exploration's contributions by real provenance without deleting its siblings", () => {
		const { deps, chats } = populated();
		const result = deleteChatTraces(deps.graphStore, "linked", "delete-nodes");
		chats.delete("linked");
		assert.equal(result.nodesRemoved, 3);
		assert.equal(result.chainsRemoved, 1);
		const graph = getGraph(deps.graphStore);
		assert.equal(graph.nodes.length, 3);
		assert.ok(graph.nodes.every((node) => node.provenance[0]?.chatId === "original"));
		assert.equal(graphSnapshot(deps).clusters[0]!.id, "original");
	});

	it("reattributes shared knowledge to its surviving passage while retaining the subject", () => {
		const { deps, chats } = populated();
		const first = getGraph(deps.graphStore).nodes[0]!;
		const repeated: SessionFindings = {
			propositions: [{ id: "again", name: first.name, statement: first.statement, aliases: [], messageId: "linked-recall" }],
			chains: [],
		};
		mergeFindings("linked", repeated, { links: [{ id: "again", linkTo: first.id }] }, deps, { foldedAt: DATE, subjectId: "original" });
		// Replaying the exact passage must not duplicate its source point.
		mergeFindings("linked", repeated, { links: [{ id: "again", linkTo: first.id }] }, deps, { foldedAt: DATE, subjectId: "original" });
		assert.equal(getGraph(deps.graphStore).nodes.find((node) => node.id === first.id)!.provenance.length, 2);
		deleteChatTraces(deps.graphStore, "original", "delete-nodes");
		chats.delete("original");
		const survivor = getGraph(deps.graphStore).nodes.find((node) => node.id === first.id)!;
		assert.deepEqual(survivor.provenance, [{ chatId: "linked", messageId: "linked-recall", subjectId: "original" }]);
		assert.equal(birthSessionOf(survivor), "original");
		assert.deepEqual(graphSnapshot(deps).nodeSessions[survivor.id], ["linked"]);
	});

	it("prefers a live original title over the exploration's retained subject label", () => {
		const { deps, chats } = populated();
		chats.get("original")!.title = "Django fundamentals";
		const snapshot = graphSnapshot(deps);
		assert.equal(snapshot.clusters[0]!.label, "Django fundamentals");
		assert.equal(snapshot.subjectLabels!.original, "Django fundamentals");
		assert.equal(snapshot.sessions.linked, "Django exploration");
	});

	it("uses the shared subject for implication tie breaking and layout communities", () => {
		const provenance = [{ chatId: "linked", messageId: "", subjectId: "original" }];
		const chain = { id: "arg_test", premises: ["a", "b"], conclusion: "c", provenance };
		const birth = new Map([["a", "original"], ["b", "other"]]);
		assert.equal(impClusterKey(chain, (id) => birth.get(id) ?? null), "original");
		const nodes: GraphNode[] = ["a", "b", "c"].map((id) => ({ id, name: id, statement: id, aliases: [], createdAt: DATE, provenance }));
		const communities = birthSessionPartition(nodes);
		attachImpToCommunities(communities, nodes, [chain]);
		assert.deepEqual(communities, [{ id: "original", members: ["a", "arg_test", "b", "c"] }]);
	});
});
