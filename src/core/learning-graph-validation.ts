import { z } from "zod";
import type { LearningContribution, LearningGraphState, LearningNodePatch, LearningPrerequisitePatch } from "./contracts.ts";
import { normalizeLearningSubjects } from "./learning-graph.ts";

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.:-]+$/).refine((value) => !["__proto__", "constructor", "prototype"].includes(value), "Invalid identifier");
const text = z.string().trim().min(1);
const date = z.iso.datetime();
const point = z.object({ chatId: id, messageId: z.string().max(200) }).strict();
const provenance = z.array(point).max(10000);
const progress = z.enum(["unassessed", "learning", "comfortable"]);
const symbol = z.object({ notation: text.max(128), meaning: text.max(2000), aliases: z.array(text.max(128)).max(30), provenance }).strict();
const evidence = z.object({ state: progress, explanation: text.max(4000), provenance, observedAt: date }).strict();
const tags = z.array(text.max(100)).max(100);
const subjects = z.array(text.max(100)).max(100).transform(normalizeLearningSubjects);
const node = z.object({ id, name: text.max(500), statement: text.max(20000), aliases: z.array(z.string().max(20000)), createdAt: date, provenance }).strict();

export const learningNodePatchSchema = z.object({
	name: text.max(200).nullable().optional(),
	subjects: subjects.nullable().optional(),
	tags: tags.nullable().optional(),
	symbols: z.array(symbol).max(100).nullable().optional(),
	progress: progress.nullable().optional(),
}).strict();

export const learningPrerequisitePatchSchema = z.object({
	from: id, to: id, enabled: z.boolean().nullable(), explanation: z.string().trim().max(4000).optional(),
}).strict();

export const learningContributionSchema = z.object({
	sourceId: id, updatedAt: date,
	fingerprint: z.string().max(500).optional(),
	messageFingerprints: z.record(z.string().max(200), z.string().max(500)).optional(),
	nodes: z.array(z.object({ nodeId: id, subjects: subjects.optional(), tags: tags.optional(), symbols: z.array(symbol).max(100).optional(), progressEvidence: z.array(evidence).optional() }).strict()),
	prerequisites: z.array(z.object({ from: id, to: id, explanation: text.max(4000), provenance }).strict()),
	groups: z.array(z.object({ id, name: text.max(200), description: z.string().max(4000), subjects: subjects.optional(), members: z.array(id) }).strict()),
	futureNodes: z.array(node).optional(),
}).strict();

export const learningGraphStateSchema = z.object({
	version: z.literal(1),
	contributions: z.record(id, learningContributionSchema),
	nodeOverrides: z.record(id, learningNodePatchSchema),
	prerequisiteOverrides: z.record(z.string(), learningPrerequisitePatchSchema),
	deletedNodeIds: z.array(id),
	nodeAliases: z.record(id, id).optional(),
}).strict();

export const parseLearningGraphState = (value: unknown): LearningGraphState => learningGraphStateSchema.parse(value);
export const parseLearningContribution = (value: unknown): LearningContribution => learningContributionSchema.parse(value);
export const parseLearningNodePatch = (value: unknown): LearningNodePatch => learningNodePatchSchema.parse(value);
export const parseLearningPrerequisitePatch = (value: unknown): LearningPrerequisitePatch => learningPrerequisitePatchSchema.parse(value);
