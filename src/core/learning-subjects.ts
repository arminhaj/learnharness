import type { LearningGraphSnapshot } from "./contracts/learning-graph.ts";
import { deriveLearningGroups, learningPrerequisiteDepth, normalizeLearningSubjects } from "./learning-graph.ts";

export const LEARNING_SUBJECT_UNASSIGNED_ID = "unassigned";

export interface LearningSubject {
	id: string;
	name: string;
	nodeIds: string[];
}

/** Encoding preserves significant punctuation: C++ and C are distinct subjects. */
export function learningSubjectId(label: string): string {
	return `subject:${encodeURIComponent(label.trim().replace(/\s+/g, " ").toLowerCase())}`;
}

/** Subjects come only from explicit memberships, including ungrouped concepts. */
export function learningSubjects(snapshot: Pick<LearningGraphSnapshot, "nodes">): LearningSubject[] {
	const subjects = new Map<string, LearningSubject>();
	const unassigned: string[] = [];
	for (const node of snapshot.nodes) {
		const labels = normalizeLearningSubjects(node.subjects ?? []);
		if (!labels.length) unassigned.push(node.id);
		for (const name of labels) {
			const id = learningSubjectId(name);
			const subject = subjects.get(id) ?? { id, name, nodeIds: [] };
			subject.nodeIds.push(node.id);
			subjects.set(id, subject);
		}
	}
	const result = [...subjects.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "en"));
	if (unassigned.length) result.push({ id: LEARNING_SUBJECT_UNASSIGNED_ID, name: "Unassigned", nodeIds: unassigned });
	return result;
}

/** A subject is a projection of the curriculum, not a new readiness assessment.
 * External blockers remain in unmetPrerequisiteIds; unrelated concepts and
 * edges never enter the scoped map. Callers inspect global details on selection. */
export function scopeLearningGraphToSubject(snapshot: LearningGraphSnapshot, subjectId: string): LearningGraphSnapshot {
	const subject = learningSubjects(snapshot).find((candidate) => candidate.id === subjectId);
	const included = new Set(subject?.nodeIds ?? []);
	const internal = (edge: { from: string; to: string }) => included.has(edge.from) && included.has(edge.to);
	const prerequisites = snapshot.prerequisites.filter(internal);
	const { depths, cycles } = learningPrerequisiteDepth([...included], prerequisites);
	const nodes = snapshot.nodes.filter((node) => included.has(node.id)).map((node) => ({ ...node, depth: depths.get(node.id) ?? 0 }));
	const memberships = new Map(snapshot.nodes.map((node) => [node.id, new Set(normalizeLearningSubjects(node.subjects ?? []).map(learningSubjectId))]));
	const subjectGroups = snapshot.groups.filter((group) => {
		const members = group.members.flatMap((id) => memberships.has(id) ? [memberships.get(id)!] : []);
		if (!members.length) return false;
		if (group.subjects !== undefined) {
			const subjects = normalizeLearningSubjects(group.subjects);
			return subjects.length ? subjects.some((label) => learningSubjectId(label) === subjectId)
				: subjectId === LEARNING_SUBJECT_UNASSIGNED_ID && members.every((subjects) => subjects.size === 0);
		}
		// Legacy names/descriptions cannot be assigned from shared members alone.
		// Require exactly one common subject across every classified member.
		const classified = members.filter((subjects) => subjects.size > 0);
		if (!classified.length) return subjectId === LEARNING_SUBJECT_UNASSIGNED_ID;
		const common = [...classified[0]!].filter((id) => classified.every((subjects) => subjects.has(id)));
		return common.length === 1 && common[0] === subjectId;
	});
	const { groups, groupEdges } = deriveLearningGroups(nodes, prerequisites, subjectGroups);
	return {
		nodes, prerequisites, prerequisiteCorrections: snapshot.prerequisiteCorrections.filter(internal),
		groups, groupEdges, cycles,
		...(snapshot.idAliases ? { idAliases: Object.fromEntries(Object.entries(snapshot.idAliases).filter(([, target]) => included.has(target))) } : {}),
	};
}
