import { z } from "zod";
import type { ChatRecord } from "./contracts.ts";
import { failedOutputCallIds, userFacingTextOf } from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";

const questionTools = new Set<string>(QUESTION_TOOLS);
const text = z.string().trim().min(1);
export const historyPassageSchema = z.object({
	id: text, messageId: text, role: z.enum(["learner", "tutor"]),
	text, unclear: z.array(z.string()), observedAt: text, fingerprint: text,
	/** A choice alone is not a learner explanation. */
	substantive: z.boolean(),
}).strict();
export type HistoryPassage = z.infer<typeof historyPassageSchema>;
export interface HistoryInput extends Omit<HistoryPassage, "fingerprint" | "unclear"> {}

export const historyEpisodeInputSchema = z.object({
	topicKey: text, topic: text, title: text,
	beforeId: text.nullable(), afterId: text,
	contextIds: z.array(text), change: text,
	subjectAssumption: z.string(), processPattern: z.string(), tutorContribution: z.string(),
	support: z.enum(["explanation", "with_help", "independent", "uncertain"]),
	strategy: z.object({ name: text, cue: text, observation: text }).strict().nullable(),
}).strict();
export type HistoryEpisodeInput = z.infer<typeof historyEpisodeInputSchema>;
const episodeSchema = historyEpisodeInputSchema.extend({ id: text, chatId: text, observedAt: text });
export type HistoryEpisode = z.infer<typeof episodeSchema>;
export const momentKinds = ["clicked", "unsure", "assumption"] as const;
export const momentLabels = { clicked: "This clicked", unsure: "Still unsure", assumption: "My assumption" } as const;
/** Rendered-text offsets, never a second stored copy of rough dictation. */
export const momentSelectionSchema = z.object({
	blockId: text.max(512), start: z.number().int().min(0).max(2_000_000), end: z.number().int().min(1).max(2_000_000),
	fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
}).strict().refine(value => value.end > value.start && value.end - value.start <= 16000, "Select up to 16,000 characters within one passage.");
export type MomentSelection = z.infer<typeof momentSelectionSchema>;

/** A change detector for display anchors, not a security/authentication hash. */
export function momentTextFingerprint(value: string): string {
	let hash = 0xcbf29ce484222325n;
	for (let i = 0; i < value.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(i))) * 0x100000001b3n);
	return hash.toString(16).padStart(16, "0");
}
export const momentSchema = z.object({
	id: text, chatId: text, messageId: text, kind: z.enum(momentKinds), note: z.string().max(4000),
	selection: momentSelectionSchema.optional(),
	/** Explicit human input; extraction has no write path to this collection. */
	origin: z.literal("learner"), surface: z.enum(["session", "history"]),
	createdAt: text, updatedAt: text, messageAt: text,
}).strict();
export type LearningMoment = z.infer<typeof momentSchema>;
export const historySourceSchema = z.object({
	passages: z.record(z.string(), historyPassageSchema),
	batches: z.record(z.string(), z.object({ fingerprint: text, passageIds: z.array(text), episodes: z.array(episodeSchema) }).strict()),
	fingerprint: z.string(), analyzedAt: z.string().nullable(), error: z.string().nullable(),
}).strict();
export type HistorySource = z.infer<typeof historySourceSchema>;
export const historyStateSchema = z.object({
	version: z.literal(1), enabled: z.boolean(),
	sources: z.record(z.string(), historySourceSchema),
	moments: z.record(z.string(), momentSchema),
	corrections: z.record(z.string(), z.string().max(8000)),
	textCorrections: z.record(z.string(), z.object({ text, fingerprint: text }).strict()),
	savedStrategies: z.array(z.string()),
}).strict();
export type LearningHistoryState = z.infer<typeof historyStateSchema>;
export const emptyLearningHistory = (): LearningHistoryState => ({ version: 1, enabled: false, sources: {}, moments: {}, corrections: {}, textCorrections: {}, savedStrategies: [] });
export const emptyHistorySource = (): HistorySource => ({ passages: {}, batches: {}, fingerprint: "", analyzedAt: null, error: null });
export interface LearningHistoryStore { read(): LearningHistoryState; write(state: LearningHistoryState): void }

/** Lossless partitioning bounds model requests without truncating long dictation. */
export function historyTextParts(value: string, limit = 6000): string[] {
	let remaining = value.trim(); const parts: string[] = [];
	while (remaining.length > limit) {
		const space = remaining.lastIndexOf(" ", limit);
		const cut = space > limit / 2 ? space : limit;
		parts.push(remaining.slice(0, cut)); remaining = remaining.slice(cut).trimStart();
	}
	if (remaining) parts.push(remaining);
	return parts;
}

/** Only authored speech and question context. No hidden reasoning, committed
 * solutions, generated opening requests, model feedback, or infrastructure. */
export function historyInputPassages(chat: Pick<ChatRecord, "messages" | "updatedAt">): HistoryInput[] {
	const failed = failedOutputCallIds(chat.messages);
	const launchPrompts = new Set(chat.messages.flatMap(m => {
		if (m.role !== "custom" || m.customType !== "graph-context") return [];
		const details = m.details as { learningContext?: { launchPrompt?: string } } | undefined;
		return details?.learningContext?.launchPrompt ? [details.learningContext.launchPrompt.trim()] : [];
	}));
	const result: HistoryInput[] = [];
	for (const m of chat.messages) {
		const add = (field: string, value: unknown, role: HistoryInput["role"], substantive = true) => {
			if (typeof value !== "string" || !value.trim()) return;
			const observedAt = Number.isFinite(m.timestamp) ? new Date(m.timestamp).toISOString() : chat.updatedAt;
			historyTextParts(value).forEach((part, i) => result.push({ id: `${m.id}:${field}:${i}`, messageId: m.id, role, text: part, substantive, observedAt }));
		};
		if (m.role === "user") {
			const speech = userFacingTextOf(m.content).join("\n");
			if (!launchPrompts.has(speech.trim())) add("text", speech, "learner");
		} else if (m.role === "custom" && m.customType === "practice-thinking") {
			add("thinking", (m.details as { text?: unknown } | undefined)?.text, "learner");
		} else if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") {
			add("text", userFacingTextOf(m.content, failed).join("\n"), "tutor", false);
			for (const block of m.content) if (block.type === "toolCall" && questionTools.has(block.name) && !failed.has(block.id)) {
				const args = block.arguments as Record<string, unknown>;
				add(`${block.id}:question`, args.question ?? args.statement, "tutor", false);
			}
		} else if (m.role === "toolResult" && !m.isError && questionTools.has(m.toolName)) {
			const answer = (m.details ?? {}) as Record<string, unknown>;
			if (answer.dismissed) continue;
			add("text", answer.text, "learner");
			add("thinking", answer.thinking ?? answer.note, "learner");
			add("readingThinking", answer.readingThinking, "learner");
			add("other", answer.other, "learner");
			if (Array.isArray(answer.answers)) add("choice", answer.answers.map(a => typeof a?.label === "string" ? a.label : "").filter(Boolean).join("; "), "learner", false);
			if (answer.dontKnow) add("dontKnow", "I don’t know.", "learner", false);
		}
	}
	return result;
}

export function historyBatches<T extends { text: string }>(passages: readonly T[], limit = 18000, overlap = 4): T[][] {
	const batches: T[][] = []; let start = 0;
	while (start < passages.length) {
		let end = start, size = 0;
		while (end < passages.length && (end === start || size + passages[end]!.text.length <= limit)) size += passages[end++]!.text.length;
		batches.push(passages.slice(start, end));
		if (end === passages.length) break;
		start = Math.max(start + 1, end - overlap);
	}
	return batches;
}

export function validateHistoryEpisodes(episodes: HistoryEpisodeInput[], passages: readonly HistoryPassage[]): string | null {
	const source = new Map(passages.map((p, i) => [p.id, { ...p, index: i }]));
	for (const e of episodes) {
		const after = source.get(e.afterId), before = e.beforeId ? source.get(e.beforeId) : null;
		if (!after || after.role !== "learner" || !after.substantive) return "A later explanation must cite substantive learner-authored speech.";
		if (e.beforeId && (!before || before.role !== "learner" || !before.substantive || before.index >= after.index)) return "An earlier explanation must precede the later learner explanation.";
		if (e.contextIds.some(id => !source.has(id))) return "Unknown context passage.";
		if ([after, before, ...e.contextIds.map(id => source.get(id))].some(p => p && p.unclear.length) && e.support !== "uncertain") return "Unresolved dictation cannot support a confident assessment.";
	}
	return null;
}

export const strategyKey = (name: string) => name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export interface HistoryRunStatus { running: boolean; chatId?: string; stage?: "cleaning" | "finding"; completed: number; total: number; error?: string }
export interface LearningHistorySnapshot {
	enabled: boolean; sessions: { id: string; title: string; parentId?: string; updatedAt: string; analyzedAt: string | null; error: string | null; pending: boolean }[];
	passages: Record<string, HistoryPassage>; episodes: HistoryEpisode[]; moments: LearningMoment[];
	corrections: Record<string, string>; savedStrategies: string[]; status: HistoryRunStatus;
}
export const historyPassageKey = (chatId: string, passageId: string) => `${chatId}/${passageId}`;

export function historyReplayGroups(snapshot: LearningHistorySnapshot) {
	const groups = new Map<string, { topic: string; samples: { chatId: string; passage: HistoryPassage }[] }>();
	for (const e of snapshot.episodes) {
		const group = groups.get(e.topicKey) ?? { topic: e.topic, samples: [] };
		for (const id of [e.beforeId, e.afterId]) {
			const p = id && snapshot.passages[historyPassageKey(e.chatId, id)];
			if (p && !group.samples.some(s => s.chatId === e.chatId && s.passage.id === p.id)) group.samples.push({ chatId: e.chatId, passage: p });
		}
		groups.set(e.topicKey, group);
	}
	return [...groups].map(([key, group]) => ({ key, ...group, samples: group.samples.sort((a, b) => a.passage.observedAt.localeCompare(b.passage.observedAt)) }));
}

export const historyMutationSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("mark"), chatId: text, messageId: text, momentId: text.optional(), selection: momentSelectionSchema.optional(), kind: z.enum(momentKinds).nullable(), note: z.string().max(4000).default(""), surface: z.enum(["session", "history"]) }).strict(),
	z.object({ action: z.literal("correct"), episodeId: text, text: z.string().max(8000) }).strict(),
	z.object({ action: z.literal("wording"), chatId: text, passageId: text, text: text.max(16000) }).strict(),
	z.object({ action: z.literal("strategy"), key: text, saved: z.boolean() }).strict(),
]);
