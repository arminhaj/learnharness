import type { GraphNode, ProvenancePoint } from "./graph.ts";

/** Personal understanding is independent of curriculum position/readiness. */
export type LearningProgress = "unassessed" | "learning" | "comfortable";

export interface LearningSymbol {
	notation: string;
	meaning: string;
	aliases: string[];
	/** The actual introduction, when known; empty means user annotation. */
	provenance: ProvenancePoint[];
}

export interface LearningProgressEvidence {
	state: LearningProgress;
	explanation: string;
	provenance: ProvenancePoint[];
	observedAt: string;
}

export interface LearningNodeContribution {
	nodeId: string;
	/** Explicit subject memberships; omission assigns no inferred taxonomy. */
	subjects?: string[];
	tags?: string[];
	symbols?: LearningSymbol[];
	progressEvidence?: LearningProgressEvidence[];
}

export interface LearningPrerequisiteInput {
	from: string;
	to: string;
	explanation: string;
	provenance: ProvenancePoint[];
}

export interface LearningGroupInput {
	id: string;
	name: string;
	description: string;
	/** Explicit subject context for the group's title and description. */
	subjects?: string[];
	members: string[];
}

/** An additive extraction contribution. All ids are resolved graph ids;
 * future nodes use a stable curriculum id and never enter evidence ledgers. */
export interface LearningContribution {
	sourceId: string;
	updatedAt: string;
	fingerprint?: string;
	messageFingerprints?: Record<string, string>;
	nodes: LearningNodeContribution[];
	prerequisites: LearningPrerequisiteInput[];
	groups: LearningGroupInput[];
	futureNodes?: GraphNode[];
}

export interface LearningNodePatch {
	/** null clears a user override and follows automatic metadata again. */
	name?: string | null;
	/** [] deliberately leaves a concept unassigned; null follows automatic. */
	subjects?: string[] | null;
	tags?: string[] | null;
	symbols?: LearningSymbol[] | null;
	progress?: LearningProgress | null;
}

export interface LearningPrerequisitePatch {
	from: string;
	to: string;
	/** null clears the correction and follows automatic evidence again. */
	enabled: boolean | null;
	explanation?: string;
}

export interface LearningGraphState {
	version: 1;
	contributions: Record<string, LearningContribution>;
	nodeOverrides: Record<string, LearningNodePatch>;
	prerequisiteOverrides: Record<string, LearningPrerequisitePatch>;
	/** Prevent a removed future concept from being resurrected by a stale run. */
	deletedNodeIds: string[];
	/** A planned concept later materialized as an identical stored proposition. */
	nodeAliases?: Record<string, string>;
}

export interface LearningPrerequisite extends LearningPrerequisiteInput {
	id: string;
	origin: "automatic" | "manual";
}

export interface LearningConcept extends GraphNode {
	subjects: string[];
	automaticSubjects: string[];
	subjectsOverride: string[] | null;
	tags: string[];
	symbols: LearningSymbol[];
	progress: LearningProgress;
	automaticProgress: LearningProgress;
	progressOverride: LearningProgress | null;
	progressEvidence: LearningProgressEvidence[];
	/** Ready means every recorded prerequisite is comfortable; it does NOT
	 * claim the concept is understood or that the map is exhaustive. */
	ready: boolean;
	unmetPrerequisiteIds: string[];
	depth: number;
	future: boolean;
	/** Inferred from source timestamps by the server; null for future nodes. */
	firstEncounteredAt: string | null;
}

export interface LearningGroup extends LearningGroupInput {
	depth: number;
	counts: Record<LearningProgress, number>;
	readyNodeIds: string[];
	blockedNodeIds: string[];
	/** Concepts outside the group that would become ready if its remaining
	 * members became comfortable; no unrelated blockers are concealed. */
	unlocks: string[];
}

export interface LearningGroupEdge {
	from: string;
	to: string;
	prerequisiteIds: string[];
}

export interface LearningGraphSnapshot {
	/** Preserve selection/edit drafts when a planned identity is reconciled. */
	idAliases?: Record<string, string>;
	nodes: LearningConcept[];
	prerequisites: LearningPrerequisite[];
	/** Includes disabled automatic edges so a correction can be reset. */
	prerequisiteCorrections: LearningPrerequisitePatch[];
	groups: LearningGroup[];
	groupEdges: LearningGroupEdge[];
	/** Cyclic prerequisite components remain visible and are never assigned
	 * an invented internal order. Members share a depth. */
	cycles: string[][];
}
