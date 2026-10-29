import type {
	GraphNode, ProvenancePoint, LearningConcept, LearningContribution,
	LearningGraphSnapshot, LearningGraphState, LearningGroup, LearningGroupEdge, LearningGroupInput,
	LearningNodeContribution, LearningNodePatch, LearningPrerequisite,
	LearningPrerequisitePatch, LearningProgress, LearningProgressEvidence, LearningSymbol,
} from "./contracts.ts";

export const LEARNING_PROGRESS = ["unassessed", "learning", "comfortable"] as const;
export function emptyLearningGraphState(): LearningGraphState {
	return { version: 1, contributions: {}, nodeOverrides: {}, prerequisiteOverrides: {}, deletedNodeIds: [] };
}

export function learningPrerequisiteId(from: string, to: string): string {
	return JSON.stringify([from, to]);
}

export function resolveLearningNodeId(state: LearningGraphState, id: string): string {
	const visited = new Set<string>();
	while (state.nodeAliases?.[id] && !visited.has(id)) {
		visited.add(id);
		id = state.nodeAliases[id]!;
	}
	return id;
}

/** Reconcile only exact proposition statements, never labels. Existing
 * corrections travel with the identity, including disabled prerequisites. */
export function reconcileLearningGraphState(storedNodes: readonly GraphNode[], input: LearningGraphState): LearningGraphState {
	const normalized = (statement: string) => statement.trim().replace(/\s+/g, " ");
	const matches = new Map<string, string[]>();
	for (const node of storedNodes) matches.set(normalized(node.statement), [...(matches.get(normalized(node.statement)) ?? []), node.id]);
	const nodeAliases = { ...input.nodeAliases };
	const storedIds = new Set(storedNodes.map((node) => node.id));
	for (const contribution of Object.values(input.contributions)) for (const node of contribution.futureNodes ?? []) {
		if (storedIds.has(node.id)) continue;
		const ids = matches.get(normalized(node.statement));
		if (ids?.length === 1 && !input.deletedNodeIds.includes(node.id) && !input.deletedNodeIds.includes(ids[0]!)) nodeAliases[node.id] = ids[0]!;
	}
	if (!Object.keys(nodeAliases).length) return input;
	const state = { ...input, nodeAliases };
	const resolve = (id: string) => resolveLearningNodeId(state, id);
	const nodeOverrides: LearningGraphState["nodeOverrides"] = {};
	// Canonical-id edits take precedence if both identities were edited.
	const overrides = Object.entries(input.nodeOverrides).sort(([a], [b]) => Number(resolve(a) === a) - Number(resolve(b) === b));
	for (const [id, override] of overrides) nodeOverrides[resolve(id)] = { ...nodeOverrides[resolve(id)], ...override };
	const prerequisiteOverrides: LearningGraphState["prerequisiteOverrides"] = {};
	for (const correction of Object.values(input.prerequisiteOverrides)) {
		const from = resolve(correction.from), to = resolve(correction.to);
		if (from !== to) prerequisiteOverrides[learningPrerequisiteId(from, to)] = { ...correction, from, to };
	}
	return {
		...state, nodeOverrides, prerequisiteOverrides, deletedNodeIds: unique(input.deletedNodeIds.map(resolve)),
		contributions: Object.fromEntries(Object.entries(input.contributions).map(([key, contribution]) => [key, {
			...contribution,
			nodes: contribution.nodes.map((node) => ({ ...node, nodeId: resolve(node.nodeId) })),
			futureNodes: contribution.futureNodes?.map((node) => ({ ...node, id: resolve(node.id) })),
			prerequisites: contribution.prerequisites.map((edge) => ({ ...edge, from: resolve(edge.from), to: resolve(edge.to) })).filter((edge) => edge.from !== edge.to),
			groups: contribution.groups.map((group) => ({ ...group, members: unique(group.members.map(resolve)) })),
		}]))
	};
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** Subject identity ignores case/spacing, but never strips meaningful punctuation. */
export function normalizeLearningSubjects(values: readonly string[]): string[] {
	const labels = new Map<string, string>();
	for (const value of values) {
		const label = value.trim().replace(/\s+/g, " ");
		if (label && !labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
	}
	return [...labels.values()];
}
function points(values: readonly ProvenancePoint[]): ProvenancePoint[] {
	const seen = new Set<string>();
	return values.filter((point) => {
		const key = JSON.stringify([point.chatId, point.messageId]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).map((point) => ({ ...point }));
}

function mergeSymbols(values: readonly LearningSymbol[]): LearningSymbol[] {
	const result = new Map<string, LearningSymbol>();
	for (const symbol of values) {
		const key = JSON.stringify([symbol.notation, symbol.meaning]);
		const previous = result.get(key);
		result.set(key, { ...symbol, aliases: unique([...(previous?.aliases ?? []), ...symbol.aliases]), provenance: points([...(previous?.provenance ?? []), ...symbol.provenance]) });
	}
	return [...result.values()];
}

function mergeEvidence(values: readonly LearningProgressEvidence[]): LearningProgressEvidence[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = JSON.stringify(value);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

/** Automatic batches accumulate evidence; they never write the override maps. */
export function mergeLearningContribution(state: LearningGraphState, incoming: LearningContribution): LearningGraphState {
	const previous = state.contributions[incoming.sourceId];
	const nodes = new Map<string, LearningNodeContribution>();
	for (const node of [...(previous?.nodes ?? []), ...incoming.nodes]) {
		const before = nodes.get(node.nodeId);
		nodes.set(node.nodeId, {
			nodeId: node.nodeId,
			subjects: normalizeLearningSubjects([...(before?.subjects ?? []), ...(node.subjects ?? [])]),
			tags: unique([...(before?.tags ?? []), ...(node.tags ?? [])]),
			symbols: mergeSymbols([...(before?.symbols ?? []), ...(node.symbols ?? [])]),
			progressEvidence: mergeEvidence([...(before?.progressEvidence ?? []), ...(node.progressEvidence ?? [])]),
		});
	}
	const prerequisites = new Map<string, LearningContribution["prerequisites"][number]>();
	for (const edge of [...(previous?.prerequisites ?? []), ...incoming.prerequisites]) {
		const key = learningPrerequisiteId(edge.from, edge.to);
		const before = prerequisites.get(key);
		prerequisites.set(key, { ...edge, provenance: points([...(before?.provenance ?? []), ...edge.provenance]) });
	}
	const groups = new Map<string, LearningContribution["groups"][number]>();
	for (const group of [...(previous?.groups ?? []), ...incoming.groups]) {
		const before = groups.get(group.id);
		groups.set(group.id, { ...group, members: unique([...(before?.members ?? []), ...group.members]),
			...(before?.subjects !== undefined || group.subjects !== undefined ? { subjects: normalizeLearningSubjects([...(before?.subjects ?? []), ...(group.subjects ?? [])]) } : {}) });
	}
	const futureNodes = new Map<string, GraphNode>();
	const knownFuture = new Map<string, GraphNode>();
	for (const contribution of Object.values(state.contributions)) for (const node of contribution.futureNodes ?? []) {
		const before = knownFuture.get(node.id);
		if (!before || node.createdAt < before.createdAt) knownFuture.set(node.id, node);
	}
	for (const node of [...(previous?.futureNodes ?? []), ...(incoming.futureNodes ?? [])]) {
		const before = futureNodes.get(node.id);
		// Snapshot-fed encounter updates may contain the user's display name.
		// Never bake that override into automatic identity, even in a new source.
		const identity = knownFuture.get(node.id) ?? before ?? node;
		futureNodes.set(node.id, { ...identity, createdAt: [identity.createdAt, node.createdAt].sort()[0]!, aliases: unique([...(before?.aliases ?? []), ...node.aliases]), provenance: points([...(before?.provenance ?? []), ...node.provenance]) });
	}
	return {
		...state,
		contributions: {
			...state.contributions,
			[incoming.sourceId]: {
				...previous, ...incoming,
				messageFingerprints: { ...previous?.messageFingerprints, ...incoming.messageFingerprints },
				nodes: [...nodes.values()], prerequisites: [...prerequisites.values()], groups: [...groups.values()], futureNodes: [...futureNodes.values()],
			},
		},
	};
}

export function patchLearningNode(state: LearningGraphState, nodeId: string, patch: LearningNodePatch): LearningGraphState {
	nodeId = resolveLearningNodeId(state, nodeId);
	if (patch.subjects) patch = { ...patch, subjects: normalizeLearningSubjects(patch.subjects) };
	const next = { ...state.nodeOverrides[nodeId] };
	for (const key of Object.keys(patch) as (keyof LearningNodePatch)[]) {
		if (patch[key] === null) delete next[key];
		else if (patch[key] !== undefined) Object.assign(next, { [key]: patch[key] });
	}
	const nodeOverrides = { ...state.nodeOverrides };
	if (Object.keys(next).length) nodeOverrides[nodeId] = next;
	else delete nodeOverrides[nodeId];
	return { ...state, nodeOverrides };
}

export function patchLearningPrerequisite(state: LearningGraphState, patch: LearningPrerequisitePatch): LearningGraphState {
	const prerequisiteOverrides = { ...state.prerequisiteOverrides };
	const id = learningPrerequisiteId(patch.from, patch.to);
	if (patch.enabled === null) delete prerequisiteOverrides[id];
	else prerequisiteOverrides[id] = { ...patch };
	return { ...state, prerequisiteOverrides };
}

/** SCC condensation gives cycles one honest layer, then computes longest
 * prerequisite depth on the resulting DAG. Neither readiness nor knowledge
 * is inferred from depth. Iterative traversal avoids a deep-graph stack. */
export function learningPrerequisiteDepth(ids: readonly string[], edges: readonly { from: string; to: string }[]): { depths: Map<string, number>; cycles: string[][] } {
	const forward = new Map(ids.map((id) => [id, [] as string[]]));
	const reverse = new Map(ids.map((id) => [id, [] as string[]]));
	for (const { from, to } of edges) {
		if (!forward.has(from) || !forward.has(to)) continue;
		forward.get(from)?.push(to);
		reverse.get(to)?.push(from);
	}
	const visited = new Set<string>();
	const finished: string[] = [];
	for (const id of ids) {
		if (visited.has(id)) continue;
		const stack: { id: string; index: number }[] = [{ id, index: 0 }];
		visited.add(id);
		while (stack.length) {
			const current = stack[stack.length - 1]!;
			const neighbors = forward.get(current.id) ?? [];
			if (current.index < neighbors.length) {
				const next = neighbors[current.index++]!;
				if (!visited.has(next)) { visited.add(next); stack.push({ id: next, index: 0 }); }
			} else { finished.push(current.id); stack.pop(); }
		}
	}
	const components: string[][] = [];
	const componentOf = new Map<string, number>();
	for (const id of finished.reverse()) {
		if (componentOf.has(id)) continue;
		const members: string[] = [];
		const stack = [id];
		componentOf.set(id, components.length);
		while (stack.length) {
			const member = stack.pop()!;
			members.push(member);
			for (const parent of reverse.get(member) ?? []) {
				if (!componentOf.has(parent)) { componentOf.set(parent, components.length); stack.push(parent); }
			}
		}
		components.push(members.sort());
	}
	const children = components.map(() => new Set<number>());
	const incoming = components.map(() => 0);
	for (const { from, to } of edges) {
		const a = componentOf.get(from), b = componentOf.get(to);
		if (a === undefined || b === undefined || a === b || children[a]!.has(b)) continue;
		children[a]!.add(b);
		incoming[b]!++;
	}
	const layers = components.map(() => 0);
	const queue = incoming.flatMap((count, index) => count === 0 ? [index] : []);
	for (let index = 0; index < queue.length; index++) {
		const component = queue[index]!;
		for (const child of children[component]!) {
			layers[child] = Math.max(layers[child]!, layers[component]! + 1);
			if (--incoming[child]! === 0) queue.push(child);
		}
	}
	return { depths: new Map(ids.map((id) => [id, layers[componentOf.get(id)!] ?? 0])), cycles: components.filter((members) => members.length > 1) };
}

/** A legacy graph deliberately has NO curriculum arrows until the learning
 * map supplies them. Reasoning entailment is not a learning prerequisite. */
export function buildLearningGraphSnapshot(
	storedNodes: readonly GraphNode[],
	state: LearningGraphState = emptyLearningGraphState(),
	firstEncounteredAt: Record<string, string> = {},
): LearningGraphSnapshot {
	state = reconcileLearningGraphState(storedNodes, state);
	const deleted = new Set(state.deletedNodeIds);
	const base = new Map(storedNodes.filter((node) => !deleted.has(node.id)).map((node) => [node.id, node]));
	const encountered = new Set(base.keys());
	const storedIds = new Set(base.keys());
	const contributions = Object.values(state.contributions).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	for (const contribution of contributions) {
		for (const node of contribution.futureNodes ?? []) {
			if (deleted.has(node.id)) continue;
			const before = base.get(node.id);
			if (before) {
				const earlier = node.createdAt < before.createdAt;
				const identity = !storedIds.has(node.id) && earlier ? node : before;
				base.set(node.id, { ...identity, createdAt: [before.createdAt, node.createdAt].sort()[0]!, aliases: unique([...before.aliases, ...node.aliases]), provenance: points([...before.provenance, ...node.provenance]) });
			}
			else base.set(node.id, node);
			if (node.provenance.length) encountered.add(node.id);
		}
	}
	const metadata = new Map<string, LearningNodeContribution[]>();
	for (const contribution of contributions) for (const node of contribution.nodes) {
		metadata.set(node.nodeId, [...(metadata.get(node.nodeId) ?? []), node]);
	}
	const edgeMap = new Map<string, LearningPrerequisite>();
	for (const contribution of contributions) for (const edge of contribution.prerequisites) {
		const id = learningPrerequisiteId(edge.from, edge.to);
		const before = edgeMap.get(id);
		edgeMap.set(id, { ...edge, id, origin: "automatic", provenance: points([...(before?.provenance ?? []), ...edge.provenance]) });
	}
	for (const correction of Object.values(state.prerequisiteOverrides)) {
		const id = learningPrerequisiteId(correction.from, correction.to);
		if (correction.enabled === false) edgeMap.delete(id);
		else if (correction.enabled === true) {
			const before = edgeMap.get(id);
			edgeMap.set(id, { id, from: correction.from, to: correction.to, explanation: correction.explanation ?? before?.explanation ?? "Added by you", provenance: before?.provenance ?? [], origin: "manual" });
		}
	}
	const prerequisites = [...edgeMap.values()].filter((edge) => edge.from !== edge.to && base.has(edge.from) && base.has(edge.to));
	const { depths, cycles } = learningPrerequisiteDepth([...base.keys()], prerequisites);
	const nodes: LearningConcept[] = [...base.values()].map((node) => {
		const rows = metadata.get(node.id) ?? [];
		const override = state.nodeOverrides[node.id];
		const progressEvidence = mergeEvidence(rows.flatMap((row) => row.progressEvidence ?? []));
		const automaticProgress = progressEvidence.at(-1)?.state ?? "unassessed";
		const automaticSubjects = normalizeLearningSubjects(rows.flatMap((row) => row.subjects ?? []));
		const subjectsOverride = override?.subjects == null ? null : normalizeLearningSubjects(override.subjects);
		const future = !encountered.has(node.id);
		return {
			...node, name: override?.name ?? node.name,
			subjects: subjectsOverride ?? automaticSubjects, automaticSubjects, subjectsOverride,
			tags: override?.tags ?? unique(rows.flatMap((row) => row.tags ?? [])),
			symbols: override?.symbols ?? mergeSymbols(rows.flatMap((row) => row.symbols ?? [])),
			progress: override?.progress ?? automaticProgress, automaticProgress,
			progressOverride: override?.progress ?? null, progressEvidence,
			ready: false, unmetPrerequisiteIds: [], depth: depths.get(node.id) ?? 0, future,
			firstEncounteredAt: future ? null : firstEncounteredAt[node.id] ?? null,
		};
	});
	const nodeMap = new Map(nodes.map((node) => [node.id, node]));
	const prerequisitesOf = new Map<string, string[]>();
	for (const edge of prerequisites) prerequisitesOf.set(edge.to, [...(prerequisitesOf.get(edge.to) ?? []), edge.from]);
	for (const node of nodes) {
		node.unmetPrerequisiteIds = (prerequisitesOf.get(node.id) ?? []).filter((id) => nodeMap.get(id)?.progress !== "comfortable");
		node.ready = node.unmetPrerequisiteIds.length === 0;
	}
	const { groups, groupEdges } = deriveLearningGroups(nodes, prerequisites, contributions.flatMap((contribution) => contribution.groups));
	return { nodes, prerequisites, prerequisiteCorrections: Object.values(state.prerequisiteOverrides).filter((edge) => base.has(edge.from) && base.has(edge.to)), groups, groupEdges, cycles,
		...(state.nodeAliases ? { idAliases: Object.fromEntries(Object.keys(state.nodeAliases).map((id) => [id, resolveLearningNodeId(state, id)])) } : {}) };
}

/** Derive group summaries only from included members. Node readiness and
 * unmet prerequisites may retain global blockers outside this projection. */
export function deriveLearningGroups(nodes: readonly LearningConcept[], prerequisites: readonly LearningPrerequisite[], inputs: readonly LearningGroupInput[]): { groups: LearningGroup[]; groupEdges: LearningGroupEdge[] } {
	const nodeMap = new Map(nodes.map((node) => [node.id, node]));
	const groupMap = new Map<string, LearningGroupInput>();
	for (const group of inputs) {
		const before = groupMap.get(group.id);
		groupMap.set(group.id, { ...group, members: unique([...(before?.members ?? []), ...group.members]).filter((id) => nodeMap.has(id)),
			...(before?.subjects !== undefined || group.subjects !== undefined ? { subjects: normalizeLearningSubjects([...(before?.subjects ?? []), ...(group.subjects ?? [])]) } : {}) });
	}
	const groups: LearningGroup[] = [...groupMap.values()].filter((group) => group.members.length).map((group) => {
		const members = new Set(group.members);
		const counts: Record<LearningProgress, number> = { unassessed: 0, learning: 0, comfortable: 0 };
		for (const id of members) counts[nodeMap.get(id)!.progress]++;
		return {
			...group, depth: 0, counts,
			readyNodeIds: group.members.filter((id) => nodeMap.get(id)!.ready && nodeMap.get(id)!.progress !== "comfortable"),
			blockedNodeIds: group.members.filter((id) => !nodeMap.get(id)!.ready && nodeMap.get(id)!.progress !== "comfortable"),
			unlocks: nodes.filter((node) => !members.has(node.id) && node.progress !== "comfortable" && !node.ready && node.unmetPrerequisiteIds.every((id) => members.has(id))).map((node) => node.id),
		};
	});
	const membership = new Map<string, string[]>();
	for (const group of groups) for (const id of group.members) membership.set(id, [...(membership.get(id) ?? []), group.id]);
	const groupEdgeMap = new Map<string, LearningGroupEdge>();
	for (const edge of prerequisites) for (const from of membership.get(edge.from) ?? []) for (const to of membership.get(edge.to) ?? []) {
		if (from === to) continue;
		const id = learningPrerequisiteId(from, to);
		const before = groupEdgeMap.get(id);
		groupEdgeMap.set(id, { from, to, prerequisiteIds: unique([...(before?.prerequisiteIds ?? []), edge.id]) });
	}
	const groupEdges = [...groupEdgeMap.values()];
	const groupDepths = learningPrerequisiteDepth(groups.map((group) => group.id), groupEdges).depths;
	for (const group of groups) group.depth = groupDepths.get(group.id) ?? 0;
	return { groups, groupEdges };
}

/** Delete identity-bound metadata too; stale automatic batches cannot revive it. */
export function removeLearningNode(state: LearningGraphState, nodeId: string): LearningGraphState {
	const nodeOverrides = { ...state.nodeOverrides };
	delete nodeOverrides[nodeId];
	return {
		...state, nodeOverrides, deletedNodeIds: unique([...state.deletedNodeIds, nodeId]),
		prerequisiteOverrides: Object.fromEntries(Object.entries(state.prerequisiteOverrides).filter(([, edge]) => edge.from !== nodeId && edge.to !== nodeId)),
		contributions: Object.fromEntries(Object.entries(state.contributions).map(([key, contribution]) => [key, {
			...contribution,
			nodes: contribution.nodes.filter((node) => node.nodeId !== nodeId),
			futureNodes: contribution.futureNodes?.filter((node) => node.id !== nodeId),
			prerequisites: contribution.prerequisites.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
			groups: contribution.groups.map((group) => ({ ...group, members: group.members.filter((id) => id !== nodeId) })).filter((group) => group.members.length),
		}]))
	};
}

/** Human annotations survive a session deletion; that session's automatic
 * evidence does not. Caller removes dead node overrides separately. */
export function removeLearningSource(state: LearningGraphState, sourceId: string): LearningGraphState {
	const keepPoints = (values: ProvenancePoint[]) => values.filter((point) => point.chatId !== sourceId);
	const keepSymbols = (values: LearningSymbol[]) => values.map((symbol) => ({ ...symbol, provenance: keepPoints(symbol.provenance) }));
	const contributions = Object.fromEntries(Object.entries(state.contributions).filter(([key]) => key !== sourceId).map(([key, contribution]) => [key, {
		...contribution,
		nodes: contribution.nodes.map((node) => ({ ...node, symbols: node.symbols ? keepSymbols(node.symbols) : undefined, progressEvidence: node.progressEvidence?.map((evidence) => ({ ...evidence, provenance: keepPoints(evidence.provenance) })).filter((evidence) => evidence.provenance.length) })),
		futureNodes: contribution.futureNodes?.filter((node) => !node.provenance.length || keepPoints(node.provenance).length).map((node) => ({ ...node, provenance: keepPoints(node.provenance) })),
		prerequisites: contribution.prerequisites.filter((edge) => !edge.provenance.length || keepPoints(edge.provenance).length).map((edge) => ({ ...edge, provenance: keepPoints(edge.provenance) })),
	}]));
	const nodeOverrides = Object.fromEntries(Object.entries(state.nodeOverrides).map(([id, override]) => [id, { ...override, ...(override.symbols ? { symbols: keepSymbols(override.symbols) } : {}) }]));
	return { ...state, contributions, nodeOverrides };
}

export function matchesLearningConcept(node: Pick<LearningConcept, "name" | "statement" | "tags" | "symbols">, query: string): boolean {
	const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\\/g, "").trim();
	const needle = normalize(query);
	if (!needle) return true;
	const greek: Record<string, string> = { "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "θ": "theta", "λ": "lambda", "μ": "mu", "π": "pi", "ρ": "rho", "σ": "sigma", "τ": "tau", "φ": "phi", "ω": "omega" };
	const expand = (value: string) => normalize(value).replace(/[αβγδεθλμπρστφω]/g, (character) => greek[character]!);
	const fields = [node.name, node.statement, ...node.tags, ...node.symbols.flatMap((symbol) => [symbol.notation, symbol.meaning, ...symbol.aliases])];
	return fields.some((field) => normalize(field).includes(needle) || expand(field).includes(expand(needle)));
}
