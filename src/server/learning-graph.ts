import type { GraphNode, GraphSnapshot, LearningContribution, LearningGraphSnapshot, LearningGraphState } from "../core/contracts.ts";
import {
	buildLearningGraphSnapshot, mergeLearningContribution, patchLearningNode,
	patchLearningPrerequisite, removeLearningNode, removeLearningSource,
	reconcileLearningGraphState, resolveLearningNodeId,
} from "../core/learning-graph.ts";
import { parseLearningContribution, parseLearningNodePatch, parseLearningPrerequisitePatch } from "../core/learning-graph-validation.ts";
import { getGraph, graphSnapshot } from "../core/graph.ts";
import { emit } from "../core/events.ts";
import { readLearningPositions, writeLearningPositions } from "../store/learning-positions.ts";
import { graphRevision } from "./graph-revision.ts";
import { stores } from "./stores.ts";

export const readLearningGraphState = (): LearningGraphState => reconcileLearningGraphState(getGraph(stores.graphStore).nodes, stores.learningGraphStore.read());

/** Source dates are factual transcript timestamps, never the extraction date. */
function firstEncounters(nodes: readonly GraphNode[]): Record<string, string> {
	const result: Record<string, string> = {};
	const chats = new Map<string, ReturnType<typeof stores.chatStore.getChat>>();
	const sources = new Map(stores.graphStore.readSources().map((source) => [source.id, source]));
	for (const node of nodes) for (const point of node.provenance) {
		if (!chats.has(point.chatId)) chats.set(point.chatId, stores.chatStore.getChat(point.chatId));
		const chat = chats.get(point.chatId);
		const message = point.messageId ? chat?.messages.find((message) => "id" in message && message.id === point.messageId) : undefined;
		const stamp = message && "timestamp" in message && typeof message.timestamp === "number"
			? message.timestamp : Date.parse(chat?.createdAt ?? sources.get(point.chatId)?.importedAt ?? "");
		if (!Number.isFinite(stamp)) continue;
		const iso = new Date(stamp).toISOString();
		if (!result[node.id] || iso < result[node.id]!) result[node.id] = iso;
	}
	return result;
}

export function effectiveGraphView(state = readLearningGraphState()): GraphSnapshot {
	const snapshot = graphSnapshot(stores);
	const allNodes = [...snapshot.propositions, ...Object.values(state.contributions).flatMap((value) => value.futureNodes ?? [])];
	const learning = buildLearningGraphSnapshot(snapshot.propositions, state, firstEncounters(allNodes));
	const effective = new Map(learning.nodes.map((node) => [node.id, node]));
	// Names are effective everywhere, while chain identity remains the stored ids.
	snapshot.propositions = snapshot.propositions.map((node) => effective.get(node.id) ?? node);
	snapshot.nodes = snapshot.nodes.map((node) => effective.get(node.id) ?? node);
	const sources = new Map(stores.graphStore.readSources().map((source) => [source.id, source]));
	for (const node of learning.nodes) {
		const ids = new Set<string>();
		const provenance = [...node.provenance, ...node.symbols.flatMap((symbol) => symbol.provenance), ...node.progressEvidence.flatMap((evidence) => evidence.provenance)];
		for (const point of provenance) {
			const chat = stores.chatStore.getChat(point.chatId);
			if (chat) { snapshot.sessions[point.chatId] = chat.title; ids.add(point.chatId); }
			const source = sources.get(point.chatId);
			if (source) { snapshot.fileSources[point.chatId] = source.filePath; ids.add(point.chatId); }
		}
		if (ids.size) snapshot.nodeSessions[node.id] = [...ids];
	}
	const positions = readLearningPositions() ?? snapshot.positions ?? {};
	snapshot.positions = {};
	for (const [id, position] of Object.entries(positions)) {
		const canonical = resolveLearningNodeId(state, id);
		if (effective.has(canonical) && (!snapshot.positions[canonical] || id === canonical)) snapshot.positions[canonical] = position;
	}
	snapshot.learning = learning;
	snapshot.graphRevision = graphRevision();
	return snapshot;
}

export function learningGraphView(): LearningGraphSnapshot {
	return effectiveGraphView().learning!;
}

export interface LearningMutationResult {
	learning: LearningGraphSnapshot;
	graphRevision: number;
}
type MutationOutcome = { ok: true } & LearningMutationResult | { ok: false; status: 400 | 404 | 409; code: string; error: string };

function persist(state: LearningGraphState): LearningMutationResult {
	state = reconcileLearningGraphState(getGraph(stores.graphStore).nodes, state);
	stores.learningGraphStore.write(state);
	const result = { learning: effectiveGraphView(state).learning!, graphRevision: graphRevision() };
	emit("graph-changed", {});
	return result;
}

/** Called through injected pipeline dependencies, never imported by agents. */
export function saveLearningContribution(contribution: LearningContribution): LearningMutationResult {
	return persist(mergeLearningContribution(readLearningGraphState(), parseLearningContribution(contribution)));
}

export function updateLearningNode(nodeId: string, input: unknown): MutationOutcome {
	let patch;
	try { patch = parseLearningNodePatch(input); }
	catch { return { ok: false, status: 400, code: "invalid_metadata", error: "Enter a nonempty name, valid subjects, tags and symbols, or an understanding state." }; }
	if (!Object.keys(patch).length) return { ok: false, status: 400, code: "empty_patch", error: "No node changes supplied." };
	const state = readLearningGraphState();
	nodeId = resolveLearningNodeId(state, nodeId);
	if (!effectiveGraphView(state).learning!.nodes.some((node) => node.id === nodeId)) {
		return { ok: false, status: 404, code: "not_found", error: "No such node" };
	}
	return { ok: true, ...persist(patchLearningNode(state, nodeId, patch)) };
}

export function updateLearningPrerequisite(input: unknown): MutationOutcome {
	let patch;
	try { patch = parseLearningPrerequisitePatch(input); }
	catch { return { ok: false, status: 400, code: "invalid_prerequisite", error: "Supply two concept ids and whether the prerequisite is enabled." }; }
	if (patch.from === patch.to) return { ok: false, status: 400, code: "self_prerequisite", error: "A concept cannot be its own prerequisite." };
	const state = readLearningGraphState();
	patch = { ...patch, from: resolveLearningNodeId(state, patch.from), to: resolveLearningNodeId(state, patch.to) };
	if (patch.from === patch.to) return { ok: false, status: 400, code: "self_prerequisite", error: "A concept cannot be its own prerequisite." };
	const learning = effectiveGraphView(state).learning!;
	const ids = new Set(learning.nodes.map((node) => node.id));
	if (!ids.has(patch.from) || !ids.has(patch.to)) return { ok: false, status: 404, code: "not_found", error: "One of these concepts no longer exists." };
	if (patch.enabled && !learning.prerequisites.some((edge) => edge.from === patch.from && edge.to === patch.to)) {
		const reachable = new Set([patch.to]);
		const queue = [patch.to];
		for (let index = 0; index < queue.length; index++) for (const edge of learning.prerequisites) {
			if (edge.from === queue[index] && !reachable.has(edge.to)) { reachable.add(edge.to); queue.push(edge.to); }
		}
		if (reachable.has(patch.from)) return { ok: false, status: 409, code: "prerequisite_cycle", error: "This would create a circular prerequisite. Remove the conflicting dependency first." };
	}
	return { ok: true, ...persist(patchLearningPrerequisite(state, patch)) };
}

/** Full node deletion also handles curriculum-only concepts. */
export function deleteLearningNodeMetadata(nodeId: string, force = false, state = readLearningGraphState()): boolean {
	nodeId = resolveLearningNodeId(state, nodeId);
	const exists = effectiveGraphView(state).learning!.nodes.some((node) => node.id === nodeId);
	const mentioned = Object.values(state.contributions).some((value) => value.nodes.some((node) => node.nodeId === nodeId) || value.futureNodes?.some((node) => node.id === nodeId)) || state.nodeOverrides[nodeId] !== undefined;
	if (exists || mentioned || force) persist(removeLearningNode(state, nodeId));
	const positions = readLearningPositions();
	if (positions && nodeId in positions) { delete positions[nodeId]; writeLearningPositions(positions); }
	return exists;
}

export function deleteLearningSessionMetadata(sourceId: string, removedNodeIds: readonly string[], identities: readonly GraphNode[] = [], state = readLearningGraphState()): number {
	let next = removeLearningSource(state, sourceId);
	const candidates = new Map([...Object.values(state.contributions).flatMap((contribution) => contribution.futureNodes ?? []), ...identities].map((node) => [node.id, node]));
	const removed = new Set(removedNodeIds);
	const liveLedgerIds = new Set(stores.graphStore.readNodes().map((node) => node.id));
	for (const [id, identity] of candidates) {
		if (liveLedgerIds.has(id)) continue;
		const references = Object.values(next.contributions).filter((contribution) =>
			contribution.nodes.some((node) => node.nodeId === id) || contribution.futureNodes?.some((node) => node.id === id) ||
			contribution.prerequisites.some((edge) => edge.from === id || edge.to === id) || contribution.groups.some((group) => group.members.includes(id)));
		if (references.length) {
			// A practice session can reference a concept before its teacher prose
			// enters the reasoning ledger. Preserve that shared identity and its
			// personal corrections using the surviving learning evidence.
			const provenance = [
				...identity.provenance.filter((point) => point.chatId !== sourceId),
				...references.flatMap((contribution) => contribution.nodes.filter((node) => node.nodeId === id).flatMap((node) => [
					...(node.progressEvidence ?? []).flatMap((evidence) => evidence.provenance),
					...(node.symbols ?? []).flatMap((symbol) => symbol.provenance),
				])),
			];
			const holder = references[0]!;
			next = mergeLearningContribution(next, { sourceId: holder.sourceId, updatedAt: holder.updatedAt, nodes: [], prerequisites: [], groups: [], futureNodes: [{ ...identity, provenance }] });
			removed.delete(id);
		}
	}
	for (const id of removed) next = removeLearningNode(next, id);
	if (JSON.stringify(next) !== JSON.stringify(state)) persist(next);
	const positions = readLearningPositions();
	if (positions) {
		const live = new Set(effectiveGraphView(next).learning!.nodes.map((node) => node.id));
		const kept = Object.fromEntries(Object.entries(positions).filter(([id]) => live.has(id)));
		if (Object.keys(kept).length !== Object.keys(positions).length) writeLearningPositions(kept);
	}
	return removedNodeIds.filter((id) => !removed.has(id)).length;
}
