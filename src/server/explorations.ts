import type { ChatRecord } from "../core/contracts.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { failedOutputCallIds, newMessageId, userFacingTextOf, type LhMessage } from "../core/native-messages.ts";
import { compactionInFlight } from "./compaction.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

export type ExplorationOutcome =
	| { ok: true; chat: ChatRecord }
	| { ok: false; status: 400 | 404 | 409; error: string };

export function listExplorations(parentChatId: string): ChatRecord[] {
	return stores.chatStore.listChats()
		.filter((chat) => chat.exploration?.parentChatId === parentChatId)
		.map((chat) => stores.chatStore.getChat(chat.id))
		.filter((chat): chat is ChatRecord => chat !== null)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Used before every transcript mutation, including automatic wakes. */
export function explorationPauseReason(chatId: string): string | null {
	const record = stores.chatStore.getChat(chatId);
	if (record?.exploration) {
		if (!stores.chatStore.getChat(record.exploration.parentChatId)) return "The original lesson is no longer available.";
		return record.exploration.status === "closed" ? "Reopen this exploration before continuing it." : null;
	}
	return stores.chatStore.listChats().some((chat) =>
		chat.exploration?.parentChatId === chatId && chat.exploration.status === "active")
		? "Return to the lesson before continuing it. An exploration is open."
		: null;
}

function busyReason(chatId: string): string | null {
	if (isTurnRunning(chatId) || compactionInFlight(chatId)) return "Wait for the current response to finish first.";
	if (stores.jobStore.listJobs(chatId).some((job) => job.status === "running")) {
		return "Wait for the lesson's background work to finish first.";
	}
	return null;
}

/** Copy only learner-visible prose. Tool arguments can contain quiz solutions,
 * and thinking blocks and tool results must never become exploration context. */
function visibleText(message: LhMessage, failedCalls?: ReadonlySet<string>): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	return userFacingTextOf(message.content, failedCalls).join("\n");
}

function seedContext(parent: ChatRecord, sourceMessageId: string): LhMessage {
	const anchorIndex = parent.messages.findIndex((message) => message.id === sourceMessageId);
	const source = parent.messages[anchorIndex]!;
	const failedCalls = failedOutputCallIds(parent.messages);
	const textOf = (message: LhMessage) => visibleText(message, failedCalls);
	const goal = parent.messages.find((message) => message.role === "user");
	const recent = parent.messages.slice(0, anchorIndex).filter((message) => textOf(message).trim()).slice(-6);
	const content = [
		"[Exploration context] The learner paused this lesson to explore an adjacent question. The original lesson and its unanswered questions remain paused. This is reference material, not a request to continue or grade the lesson.",
		`Lesson: ${parent.title}`,
		...(goal ? [`Original learning goal: ${textOf(goal).slice(0, 2000)}`] : []),
		"Recent visible conversation:",
		...recent.map((message) => `${message.role === "user" ? "Learner" : "Tutor"}: ${textOf(message).slice(0, 2000)}`),
		`Passage being explored:\n${textOf(source).slice(0, 8000)}`,
	].join("\n\n");
	return { id: newMessageId(), role: "custom", customType: "exploration-context", content, display: false, details: { parentChatId: parent.id, sourceMessageId }, timestamp: Date.now() };
}

export function createExploration(parentChatId: string, input: { sourceMessageId?: unknown; topic?: unknown }): ExplorationOutcome {
	const parent = stores.chatStore.getChat(parentChatId);
	if (!parent) return { ok: false, status: 404, error: "No such lesson" };
	if (parent.exploration || parent.kind === "practice") return { ok: false, status: 400, error: "Start an exploration from a teaching lesson." };
	if (typeof input?.sourceMessageId !== "string" || typeof input?.topic !== "string" || !input.topic.trim() || input.topic.trim().length > 2000) {
		return { ok: false, status: 400, error: "Choose a passage and enter an exploration question (up to 2,000 characters)." };
	}
	const source = parent.messages.find((message) => message.id === input.sourceMessageId);
	if (!source || source.role !== "assistant" || source.stopReason === "error" || source.stopReason === "aborted" || !visibleText(source, failedOutputCallIds(parent.messages)).trim()) {
		return { ok: false, status: 400, error: "Choose a completed tutor explanation in this lesson." };
	}
	const blocked = busyReason(parentChatId) ?? explorationPauseReason(parentChatId);
	if (blocked) return { ok: false, status: 409, error: blocked };
	const topic = input.topic.trim();
	const strong = stores.settingsStore.readSettings()?.models?.strong;
	const settings = parent.settings?.model ? parent.settings : strong?.model ? {
		model: { provider: strong.model.provider, id: strong.model.id },
		thinkingLevel: parent.settings?.thinkingLevel ?? strong.thinkingLevel,
	} : parent.settings;
	// One synchronous create: no transient sidebar entry or partially seeded
	// child can be observed, and the parent record is never rewritten.
	const chat = stores.chatStore.createChat(titleFromPrompt(topic), undefined, {
		exploration: { parentChatId, sourceMessageId: source.id, parentTitle: parent.title, topic, status: "active" },
		messages: [seedContext(parent, source.id)],
		...(settings ? { settings } : {}),
	});
	return { ok: true, chat };
}

export function updateExploration(parentChatId: string, childId: string, action: unknown): ExplorationOutcome {
	const parent = stores.chatStore.getChat(parentChatId);
	const child = stores.chatStore.getChat(childId);
	if (!parent || !child || child.exploration?.parentChatId !== parentChatId) return { ok: false, status: 404, error: "No such exploration in this lesson" };
	if (action !== "close" && action !== "reopen") return { ok: false, status: 400, error: "Choose close or reopen." };
	const status = action === "close" ? "closed" : "active";
	if (child.exploration.status === status) return { ok: true, chat: child };
	const blocked = busyReason(childId) ?? (action === "reopen" ? busyReason(parentChatId) ?? explorationPauseReason(parentChatId) : null);
	if (blocked) return { ok: false, status: 409, error: blocked };
	return { ok: true, chat: stores.chatStore.setExplorationStatus(childId, status) };
}
