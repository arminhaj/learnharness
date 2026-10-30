import { createHash } from "node:crypto";
import { cleanHistorySpeech, findHistoryEpisodes } from "../agent/subagents/learning-history.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { callUsage } from "../agent/subagents/extraction.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ExtractionRunUsage } from "../core/contracts.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { emit } from "../core/events.ts";
import {
	emptyHistorySource, historyBatches, historyInputPassages, historyMutationSchema, historyPassageKey,
	strategyKey, validateHistoryEpisodes,
	type HistoryPassage, type HistorySource, type LearningHistorySnapshot, type LearningHistoryStore,
	type HistoryRunStatus, type LearningHistoryState,
} from "../core/learning-history.ts";
import { stores } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";

const VERSION = "history-v1-coherence-v1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const passageFingerprint = (value: unknown) => hash([VERSION, value]);
export class HistoryRequestError extends Error { constructor(message: string, public status = 400) { super(message); } }

interface Dependencies {
	chatStore: ChatStore; historyStore: LearningHistoryStore;
	engine: () => PiEngine | undefined;
	clean?: typeof cleanHistorySpeech; analyze?: typeof findHistoryEpisodes;
}

/** Single writer service. Each await is followed by a fresh state read, so
 * marking/correcting during model work cannot be overwritten by stale state. */
export function createLearningHistoryService(deps: Dependencies) {
	const queue = new Set<string>(); let controller: AbortController | null = null;
	const status: HistoryRunStatus = { running: false, completed: 0, total: 0 };
	const notify = () => emit("learning-history-changed", {});
	const write = (edit: (state: LearningHistoryState) => void) => { const state = deps.historyStore.read(); edit(state); deps.historyStore.write(state); notify(); };
	const inputs = (id: string) => { const chat = deps.chatStore.getChat(id); return chat ? historyInputPassages(chat) : []; };
	const signature = (id: string, state = deps.historyStore.read(), sourceInputs = inputs(id)) => hash([VERSION, sourceInputs, Object.values(state.moments).filter(m => m.chatId === id), Object.entries(state.textCorrections).filter(([key]) => key.startsWith(`${id}/`))]);
	function effectivePassage(chatId: string, passage: HistoryPassage, state: LearningHistoryState) {
		const edit = state.textCorrections[historyPassageKey(chatId, passage.id)];
		return edit?.fingerprint === passage.fingerprint ? { ...passage, text: edit.text, unclear: [] } : passage;
	}
	function currentSource(id: string, state: LearningHistoryState, sourceInputs = inputs(id)): HistorySource {
		const stored = state.sources[id] ?? emptyHistorySource();
		const valid = new Map(sourceInputs.map(p => [p.id, passageFingerprint(p)]));
		const passages = Object.fromEntries(Object.entries(stored.passages).filter(([key, p]) => valid.get(key) === p.fingerprint).map(([key, p]) => [key, effectivePassage(id, p, state)]));
		const batches = Object.fromEntries(Object.entries(stored.batches).filter(([, batch]) => {
			const current = batch.passageIds.map(id => passages[id]);
			if (current.some(p => !p)) return false;
			const moments = Object.values(state.moments).filter(m => m.chatId === id && current.some(p => p?.messageId === m.messageId));
			return batch.fingerprint === hash([VERSION, current, moments]);
		}));
		return { ...stored, passages, batches };
	}
	function snapshot(): LearningHistorySnapshot {
		const state = deps.historyStore.read(), summaries = deps.chatStore.listChats();
		const passages: LearningHistorySnapshot["passages"] = {}, episodes: LearningHistorySnapshot["episodes"] = [];
		const sessions = summaries.map(summary => {
			const chat = deps.chatStore.getChat(summary.id)!;
			const sourceInputs = historyInputPassages(chat), source = currentSource(chat.id, state, sourceInputs);
			for (const p of Object.values(source.passages)) passages[historyPassageKey(chat.id, p.id)] = p;
			for (const batch of Object.values(source.batches)) for (const e of batch.episodes) if (!episodes.some(other => other.id === e.id)) episodes.push(e);
			return { id: chat.id, title: chat.title, parentId: chat.exploration?.parentChatId, updatedAt: chat.updatedAt, analyzedAt: source.analyzedAt, error: source.error, pending: source.fingerprint !== signature(chat.id, state, sourceInputs) };
		});
		const live = new Set(sessions.map(s => s.id));
		const moments = Object.values(state.moments).filter(m => live.has(m.chatId) && deps.chatStore.getChat(m.chatId)?.messages.some(p => p.id === m.messageId));
		return { enabled: state.enabled, sessions, passages, episodes: episodes.sort((a, b) => a.observedAt.localeCompare(b.observedAt)), moments, corrections: state.corrections, savedStrategies: state.savedStrategies, status: { ...status } };
	}
	async function processSource(id: string, signal: AbortSignal) {
		const chat = deps.chatStore.getChat(id); if (!chat) return;
		const initial = deps.historyStore.read(), startSignature = signature(id, initial);
		if (initial.sources[id]?.fingerprint === startSignature) return;
		const sourceInputs = inputs(id);
		const engine = deps.engine(); if (sourceInputs.length && !engine) throw new Error("Configure an extraction model and its provider connection in Settings to build learning history.");
		const startedAt = Date.now();
		const usage: ExtractionRunUsage = { startedAt, at: new Date().toISOString(), durationMs: 0, purpose: "learning-history", stages: { extractor: { model: "", steps: [] }, auditor: { model: "", steps: [] } } };
		const stageOptions = (stage: "extractor" | "auditor") => ({ engine: engine!, signal, onStep: (step: Parameters<typeof callUsage>[0], model: string) => { usage.stages[stage].model = model; usage.stages[stage].steps.push(callUsage(step)); } });
		const alive = () => { signal.throwIfAborted(); if (!deps.chatStore.getChat(id)) throw new Error("This session was deleted."); };
		try {
			write(state => { const source = currentSource(id, state); state.sources[id] = { ...source, error: null }; });
			status.stage = "cleaning"; notify();
			const savedPassages = deps.historyStore.read().sources[id]?.passages ?? {};
			const remaining = sourceInputs.filter(p => !savedPassages[p.id]);
			for (const batch of historyBatches(remaining, 18000, 0)) {
				alive(); const cleaned = await (deps.clean ?? cleanHistorySpeech)(batch, stageOptions("extractor")); alive();
				if (cleaned.length !== batch.length || cleaned.some((p, i) => p.id !== batch[i]?.id || !p.text.trim())) throw new Error("Speech cleanup omitted or changed a passage identity.");
				write(state => {
					const source = state.sources[id] ?? emptyHistorySource();
					cleaned.forEach((p, i) => { const original = batch[i]!; source.passages[p.id] = { ...original, ...p, fingerprint: passageFingerprint(original) }; });
					state.sources[id] = source;
				});
			}
			alive(); status.stage = "finding"; notify();
			const state = deps.historyStore.read(), source = currentSource(id, state);
			const cleaned = sourceInputs.map(p => source.passages[p.id]).filter((p): p is HistoryPassage => Boolean(p));
			const batchKeys: string[] = [];
			for (const batch of historyBatches(cleaned)) {
				alive();
				const key = hash(batch.map(p => p.id)), moments = Object.values(deps.historyStore.read().moments).filter(m => m.chatId === id && batch.some(p => p.messageId === m.messageId));
				const fingerprint = hash([VERSION, batch, moments]); batchKeys.push(key);
				if (deps.historyStore.read().sources[id]?.batches[key]?.fingerprint === fingerprint) continue;
				// Reuse names from the previous run even if corrected wording
				// invalidated its evidence. Labels are hints, not accepted findings.
				const known = [...snapshot().episodes, ...Object.values(initial.sources[id]?.batches ?? {}).flatMap(b => b.episodes)];
				const topics = [...new Map(known.map(e => [e.topicKey, { key: e.topicKey, name: e.topic }])).values()];
				const strategies = [...new Set(known.flatMap(e => e.strategy ? [e.strategy.name] : []))];
				const found = await (deps.analyze ?? findHistoryEpisodes)(batch, { topics, strategies, moments }, stageOptions("auditor")); alive();
				const problem = validateHistoryEpisodes(found, batch); if (problem) throw new Error(problem);
				const episodes = found.map(e => ({ ...e, chatId: id, id: hash([id, e.topicKey, e.beforeId, e.afterId]), observedAt: batch.find(p => p.id === e.afterId)!.observedAt }));
				write(current => { (current.sources[id] ??= emptyHistorySource()).batches[key] = { fingerprint, passageIds: batch.map(p => p.id), episodes }; });
			}
			alive();
			write(current => {
				const source = current.sources[id] ?? emptyHistorySource();
				source.batches = Object.fromEntries(Object.entries(source.batches).filter(([key]) => batchKeys.includes(key)));
				source.fingerprint = startSignature; source.analyzedAt = new Date().toISOString(); source.error = null;
				current.sources[id] = source;
			});
			if (signature(id) !== startSignature) queue.add(id);
		} finally {
			if (deps.chatStore.getChat(id) && Object.values(usage.stages).some(s => s.steps.length)) {
				usage.durationMs = Date.now() - startedAt; deps.chatStore.appendExtractionUsage(id, usage);
			}
		}
	}
	async function drain() {
		if (status.running) return;
		status.running = true; status.error = undefined; controller = new AbortController(); notify();
		try {
			while (queue.size && !controller.signal.aborted) {
				const id = queue.values().next().value!; queue.delete(id); status.chatId = id; notify();
				try { await processSource(id, controller.signal); }
				catch (error) {
					const message = controller.signal.aborted ? "History update stopped. Completed work is saved." : error instanceof Error ? error.message : "History update failed.";
					status.error = message;
					try { if (deps.chatStore.getChat(id)) write(state => { (state.sources[id] ??= emptyHistorySource()).error = message; }); }
					catch { /* Keep the visible run error if storage itself is unavailable. */ }
				}
				status.completed++; notify();
			}
		} finally { status.running = false; status.chatId = undefined; status.stage = undefined; controller = null; notify(); }
	}
	function refresh(chatId?: string) {
		if (chatId && !deps.chatStore.getChat(chatId)) throw new HistoryRequestError("Session not found.", 404);
		if (!deps.engine()) throw new HistoryRequestError("Configure an extraction model and its provider connection in Settings to build learning history.", 503);
		write(state => { state.enabled = true; });
		const ids = chatId ? [chatId] : deps.chatStore.listChats().slice().reverse().map(s => s.id);
		if (!status.running) { status.completed = 0; status.total = 0; }
		let added = 0;
		const state = deps.historyStore.read();
		for (const id of ids) if (!queue.has(id) && state.sources[id]?.fingerprint !== signature(id, state)) { queue.add(id); status.total++; added++; }
		if (queue.size) void drain();
		return { queued: added };
	}
	function mutate(input: unknown) {
		const parsed = historyMutationSchema.safeParse(input); if (!parsed.success) throw new HistoryRequestError("Invalid learning-history change.");
		const value = parsed.data;
		if (value.action === "mark") {
			const chat = deps.chatStore.getChat(value.chatId), m = chat?.messages.find(m => m.id === value.messageId);
			if (!chat || !m || !historyInputPassages(chat).some(p => p.messageId === m.id)) throw new HistoryRequestError("This conversation passage is not available yet.", 404);
			write(state => {
				const id = `${value.chatId}/${value.messageId}`;
				if (value.kind === null) { delete state.moments[id]; return; }
				const now = new Date().toISOString();
				state.moments[id] = { id, chatId: chat.id, messageId: m.id, kind: value.kind, note: value.note, origin: "learner", surface: value.surface, createdAt: state.moments[id]?.createdAt ?? now, updatedAt: now, messageAt: Number.isFinite(m.timestamp) ? new Date(m.timestamp).toISOString() : chat.updatedAt };
			});
		} else if (value.action === "correct") {
			if (!snapshot().episodes.some(e => e.id === value.episodeId)) throw new HistoryRequestError("Episode not found.", 404);
			write(state => { state.corrections[value.episodeId] = value.text; });
		} else if (value.action === "wording") {
			const p = snapshot().passages[historyPassageKey(value.chatId, value.passageId)];
			if (!p) throw new HistoryRequestError("Passage not found.", 404);
			write(state => { state.textCorrections[historyPassageKey(value.chatId, value.passageId)] = { text: value.text, fingerprint: p.fingerprint }; });
		} else {
			if (!snapshot().episodes.some(e => e.strategy && strategyKey(e.strategy.name) === value.key)) throw new HistoryRequestError("Strategy not found.", 404);
			write(state => { state.savedStrategies = value.saved ? [...new Set([...state.savedStrategies, value.key])] : state.savedStrategies.filter(key => key !== value.key); });
		}
		if ((value.action === "mark" || value.action === "wording") && deps.historyStore.read().enabled) { try { refresh(value.chatId); } catch { /* marker/wording remains durable without a model */ } }
		return snapshot();
	}
	function removeSource(id: string) {
		queue.delete(id);
		write(state => {
			const episodeIds = new Set(Object.values(state.sources[id]?.batches ?? {}).flatMap(b => b.episodes.map(e => e.id)));
			delete state.sources[id];
			state.moments = Object.fromEntries(Object.entries(state.moments).filter(([, m]) => m.chatId !== id));
			state.textCorrections = Object.fromEntries(Object.entries(state.textCorrections).filter(([key]) => !key.startsWith(`${id}/`)));
			state.corrections = Object.fromEntries(Object.entries(state.corrections).filter(([key]) => !episodeIds.has(key)));
		});
	}
	return {
		snapshot, refresh, mutate, removeSource,
		momentTargets(chatId: string) { return [...new Set(inputs(chatId).map(p => p.messageId))]; },
		momentsFor(chatId: string) {
			const chat = deps.chatStore.getChat(chatId); if (!chat) throw new HistoryRequestError("Session not found.", 404);
			return Object.values(deps.historyStore.read().moments).filter(m => m.chatId === chatId && chat.messages.some(p => p.id === m.messageId));
		},
		cancel() { queue.clear(); controller?.abort(); },
		async idle() { while (status.running) await new Promise(resolve => setTimeout(resolve, 5)); },
	};
}

const globalHistory = globalThis as typeof globalThis & { __lhLearningHistory?: ReturnType<typeof createLearningHistoryService> };
export const learningHistory = globalHistory.__lhLearningHistory ??= createLearningHistoryService({
	chatStore: stores.chatStore, historyStore: stores.learningHistoryStore,
	engine: () => { const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings()); return spec && providerKeyPresent(spec.provider) ? piEngineForSpec(spec) : undefined; },
});
export function updateLearningHistoryAfterTurn(chatId: string): void {
	try { if (stores.learningHistoryStore.read().enabled) learningHistory.refresh(chatId); }
	catch (error) { console.error("[learning history] Update could not start:", error instanceof Error ? error.message : error); }
}
