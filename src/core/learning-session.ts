import type { LearningConcept, LearningGraphSnapshot, LearningProgress } from "./contracts/learning-graph.ts";
import { resolveTargetId } from "./chains.ts";
import { stripModelValueDebris } from "./value-debris.ts";

export type ConceptSessionMode = "teach" | "practice";

/** The browser sends identity and a goal; the server supplies factual context. */
export interface ConceptSessionRequest {
	title: string;
	kind?: "practice";
	learningContext: { nodeId: string };
}

export interface LearningSessionContext {
	nodeId: string;
	mode: ConceptSessionMode;
	/** Used only to recognize the generated opening request, never as evidence. */
	launchPrompt: string;
	progress: LearningProgress;
	symbols: { notation: string; meaning: string }[];
	prerequisites: { id: string; name: string; statement: string; progress: LearningProgress }[];
}

export function createConceptSessionRequest(node: Pick<LearningConcept, "id" | "name">, mode: ConceptSessionMode): ConceptSessionRequest {
	return {
		title: mode === "practice"
			? `Test my understanding of ${node.name}. Give me one problem at a time and wait for my work before showing an answer.`
			: `Teach me ${node.name}. Start with the prerequisites I need and guide me one step at a time.`,
		...(mode === "practice" ? { kind: "practice" as const } : {}),
		learningContext: { nodeId: node.id },
	};
}

/** A session can outlive reconciliation of a planned id into a ledger id. */
export function resolveLearningSessionTarget(snapshot: Pick<LearningGraphSnapshot, "nodes" | "idAliases">, target: string): string | null {
	const id = stripModelValueDebris(target);
	return resolveTargetId(snapshot.idAliases?.[id] ?? id, snapshot.nodes);
}
