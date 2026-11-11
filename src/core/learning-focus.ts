import type { LearningGraphSnapshot } from "./contracts/learning-graph.ts";
import { learningPrerequisiteId } from "./learning-graph.ts";

export type LearningFocusDirection = "prerequisites" | "unlocks";

export interface LearningFocus {
	direction: LearningFocusDirection;
	/** Level zero contains the anchor. Each subsequent level is one edge farther away. */
	levels: string[][];
	/** Every recorded neighbor one shortest step closer to the anchor. */
	towardAnchor: Map<string, string[]>;
}

export function learningFocus(
	graph: Pick<LearningGraphSnapshot, "nodes" | "prerequisites" | "idAliases">,
	anchorId: string,
	direction: LearningFocusDirection,
): LearningFocus {
	const levels: string[][] = [];
	const towardAnchor = new Map<string, string[]>();
	const focus = { direction, levels, towardAnchor };
	const aliases = graph.idAliases ?? {};
	const canonical = (id: string) => Object.hasOwn(aliases, id) ? aliases[id] ?? id : id;
	const anchor = canonical(anchorId);
	const included = new Set(graph.nodes.map(({ id }) => canonical(id)));
	if (!included.has(anchor)) return focus;

	const outward = new Map<string, Set<string>>();
	for (const edge of graph.prerequisites) {
		const from = canonical(edge.from), to = canonical(edge.to);
		if (from === to || !included.has(from) || !included.has(to)) continue;
		const closer = direction === "prerequisites" ? to : from;
		const farther = direction === "prerequisites" ? from : to;
		const neighbors = outward.get(closer) ?? new Set<string>();
		neighbors.add(farther);
		outward.set(closer, neighbors);
	}

	const distances = new Map([[anchor, 0]]);
	levels.push([anchor]);
	for (let distance = 0; distance < levels.length; distance++) {
		const nextLevel: string[] = [];
		const nextDistance = distance + 1;
		for (const closer of levels[distance]!) {
			for (const farther of outward.get(closer) ?? []) {
				const knownDistance = distances.get(farther);
				if (knownDistance === undefined) {
					distances.set(farther, nextDistance);
					nextLevel.push(farther);
					towardAnchor.set(farther, [closer]);
				} else if (knownDistance === nextDistance) {
					towardAnchor.get(farther)!.push(closer);
				}
			}
		}
		if (nextLevel.length > 0) levels.push(nextLevel);
	}
	return focus;
}

/** Walk the shortest-path predecessor graph once, even when routes share steps. */
export function learningFocusLevel(focus: LearningFocus, level: number, showPaths: boolean): {
	levelIds: string[];
	pathIds: Set<string>;
	pathEdgeIds: Set<string>;
} {
	const levelIds = focus.levels[level] ?? [];
	const pathIds = new Set<string>();
	const pathEdgeIds = new Set<string>();
	const visible = { levelIds, pathIds, pathEdgeIds };
	if (!showPaths) return visible;

	const stack = [...levelIds];
	while (stack.length > 0) {
		const farther = stack.pop()!;
		for (const closer of focus.towardAnchor.get(farther) ?? []) {
			pathEdgeIds.add(focus.direction === "prerequisites"
				? learningPrerequisiteId(farther, closer)
				: learningPrerequisiteId(closer, farther));
			if (pathIds.has(closer)) continue;
			pathIds.add(closer);
			stack.push(closer);
		}
	}
	return visible;
}
