import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { HistoryEpisodeInput, HistoryPassage } from "../src/core/learning-history.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-history-test-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
const { chatStore } = await import("../src/store/chats.ts");
const { createLearningHistoryStore } = await import("../src/store/learning-history.ts");
const { createLearningHistoryService } = await import("../src/server/learning-history.ts");
const { historyInputPassages, historyBatches, historyReplayGroups, historyPassageKey, validateHistoryEpisodes } = await import("../src/core/learning-history.ts");
const { cleanHistorySpeech, findHistoryEpisodes, COHERENCE_PROMPT } = await import("../src/agent/subagents/learning-history.ts");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const user = (id: string, text: string, timestamp = 1): LhMessage => ({ id, role: "user", content: text, timestamp });
const teacher = (id: string, text: string, timestamp = 2): LhMessage => ({ ...fauxAssistantMessage([{ type: "text", text }]), id, timestamp });
const messages = [user("before", "um so motion needs a force all the time"), teacher("help", "Consider a puck moving without friction."), user("after", "Oh… a force changes velocity, it does not maintain it.", 3)];
const cleaned = (passages: ReturnType<typeof historyInputPassages>): HistoryPassage[] => passages.map(p => ({ ...p, fingerprint: "fixture", unclear: [] }));
const episode = (passages: readonly HistoryPassage[]): HistoryEpisodeInput => ({
	topicKey: "force-motion", topic: "Force and motion", title: "Separating motion from change in motion",
	beforeId: passages.find(p => p.messageId === "before")!.id, afterId: passages.find(p => p.messageId === "after")!.id,
	contextIds: passages.filter(p => p.role === "tutor").map(p => p.id), change: "The frictionless example was followed by a different explanation.",
	subjectAssumption: "Continued motion requires force.", processPattern: "Checking a familiar rule against a limiting case.", tutorContribution: "The tutor introduced the no-friction case.", support: "with_help",
	strategy: { name: "Test a limiting case", cue: "Remove one condition and check the claim.", observation: "The learner distinguished velocity from acceleration after the example." },
});
function fixture(options: Partial<Parameters<typeof createLearningHistoryService>[0]> = {}) {
	const chat = chatStore.createChat("Existing physics session", undefined, { messages });
	const historyStore = createLearningHistoryStore(path.join(directory, `${chat.id}.history.json`));
	const calls = { clean: 0, analyze: 0 };
	const service = createLearningHistoryService({
		chatStore, historyStore, engine: () => ({} as PiEngine),
		clean: async input => { calls.clean++; return input.map(p => ({ id: p.id, text: p.text.replace("um so motion", "Motion"), unclear: [] })); },
		analyze: async input => { calls.analyze++; return [episode(input)]; },
		...options,
	});
	return { chat, historyStore, calls, service };
}
function submitEngine(name: string, results: unknown[]) {
	const faux = createFauxCore({});
	faux.setResponses(results.map((result, i) => () => fauxAssistantMessage([fauxToolCall(name, result as ToolCall["arguments"], { id: `submit-${i}` })], { stopReason: "toolUse" })));
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("learning-history source evidence", () => {
	it("uses historic answers and reading reflections, excluding hidden reasoning, solutions and generated launch text", () => {
		const transcript: LhMessage[] = [
			{ id: "launch", role: "custom", customType: "graph-context", content: "", display: false, timestamp: 0, details: { learningContext: { launchPrompt: "Generated opening" } } },
			user("opening", "Generated opening"), ...messages,
			{ ...fauxAssistantMessage([{ type: "thinking", thinking: "PRIVATE" }, fauxToolCall("quiz", { question: "Why?", correctAnswer: "SECRET" })]), id: "question" },
			{ role: "toolResult", id: "answer", toolCallId: "q1", toolName: "quiz", content: [{ type: "text", text: "MODEL FEEDBACK" }], details: { note: "I assumed the force must continue", readingThinking: "I need to compare acceleration", answers: [{ label: "No net force" }], correct: true }, isError: false, timestamp: 4 },
			{ role: "toolResult", id: "dismissed", toolCallId: "q2", toolName: "quiz", content: [], details: { dismissed: true, text: "not evidence" }, isError: false, timestamp: 5 },
		];
		const passages = historyInputPassages({ messages: transcript, updatedAt: "2026-01-01" });
		const text = passages.map(p => p.text).join("\n");
		assert.match(text, /assumed the force/); assert.match(text, /compare acceleration/); assert.match(text, /Why\?/);
		assert.doesNotMatch(text, /PRIVATE|SECRET|MODEL FEEDBACK|Generated opening|not evidence/);
		assert.equal(passages.find(p => p.text === "No net force")?.substantive, false);
	});
	it("keeps every word of long dictation across bounded batches", () => {
		const text = Array.from({ length: 10000 }, (_, i) => `thought${i}`).join(" ");
		const passages = historyInputPassages({ messages: [user("long", text)], updatedAt: "2026-01-01" });
		assert.equal(passages.map(p => p.text).join(" "), text);
		assert.ok(passages.every(p => p.text.length <= 6000));
		assert.deepEqual(historyBatches(passages, 18000, 0).flat().map(p => p.id), passages.map(p => p.id));
	});
	it("rejects teacher-only, reversed, choice-only and uncertain evidence being called demonstrated", () => {
		const input = cleaned(historyInputPassages({ messages, updatedAt: "2026-01-01" }));
		const e = episode(input);
		assert.equal(validateHistoryEpisodes([e], input), null);
		assert.match(validateHistoryEpisodes([{ ...e, afterId: input[1]!.id }], input)!, /learner-authored/);
		assert.match(validateHistoryEpisodes([{ ...e, beforeId: e.afterId }], input)!, /precede/);
		assert.match(validateHistoryEpisodes([e], input.map(p => p.id === e.afterId ? { ...p, substantive: false } : p))!, /substantive/);
		input[0]!.unclear = ["force or source"];
		assert.match(validateHistoryEpisodes([e], input)!, /Unresolved dictation/);
		assert.equal(validateHistoryEpisodes([{ ...e, support: "uncertain" }], input), null);
	});
	it("runs a dedicated coherence agent that retries omitted passages and preserves the speaker boundary", async () => {
		const input = historyInputPassages({ messages, updatedAt: "2026-01-01" });
		const result = input.map(p => ({ id: p.id, text: p.text, unclear: [] }));
		let steps = 0;
		const output = await cleanHistorySpeech(input, { engine: submitEngine("submit_coherent_speech", [{ passages: result.slice(1) }, { passages: result }]), signal: new AbortController().signal, onStep: () => { steps++; } });
		assert.equal(steps, 2); assert.deepEqual(output, result);
		assert.match(COHERENCE_PROMPT, /NOT summarization/); assert.match(COHERENCE_PROMPT, /incorrect assumption/);
	});
	it("retries an analysis that mistakes a tutor explanation for a learner demonstration", async () => {
		const input = cleaned(historyInputPassages({ messages, updatedAt: "2026-01-01" })), e = episode(input);
		let steps = 0;
		const output = await findHistoryEpisodes(input, { topics: [], strategies: [], moments: [] }, { engine: submitEngine("submit_learning_history", [{ episodes: [{ ...e, afterId: input[1]!.id }] }, { episodes: [e] }]), signal: new AbortController().signal, onStep: () => { steps++; } });
		assert.equal(steps, 2); assert.deepEqual(output, [e]);
	});
});

describe("learning history persistence and backfill", () => {
	it("backfills existing sessions once, stores cleaned speech, and never invents a learner marker", async () => {
		const { chat, historyStore, calls, service } = fixture();
		service.refresh(chat.id); await service.idle();
		const snapshot = service.snapshot();
		assert.equal(snapshot.episodes.length, 1); assert.equal(snapshot.moments.length, 0);
		assert.equal(snapshot.sessions.find(s => s.id === chat.id)?.pending, false);
		assert.equal(snapshot.passages[historyPassageKey(chat.id, "before:text:0")]!.text, "Motion needs a force all the time");
		assert.doesNotMatch(JSON.stringify(historyStore.read()), /um so motion/);
		assert.equal(chatStore.getChat(chat.id)!.messages[0]!.content, messages[0]!.content, "the teacher's native replay record is not rewritten");
		service.refresh(chat.id); await service.idle(); assert.deepEqual(calls, { clean: 1, analyze: 1 });
		const restored = createLearningHistoryService({ chatStore, historyStore, engine: () => undefined });
		assert.deepEqual(restored.snapshot().episodes, snapshot.episodes, "history survives a process restart");
	});
	it("records genuine learner markers immediately, with separate message and marking times", () => {
		const { chat, service } = fixture({ engine: () => undefined });
		const marked = service.mutate({ action: "mark", chatId: chat.id, messageId: "help", kind: "clicked", note: "The puck example", surface: "session" }).moments[0]!;
		assert.equal(marked.origin, "learner"); assert.equal(marked.messageAt, new Date(2).toISOString());
		assert.ok(new Date(marked.createdAt).getTime() > 2);
		assert.equal(service.momentsFor(chat.id).length, 1);
		assert.throws(() => service.mutate({ action: "mark", chatId: chat.id, messageId: "missing", kind: "clicked", surface: "session" }), /not available/);
		service.mutate({ action: "mark", chatId: chat.id, messageId: "help", kind: null, surface: "session" });
		assert.equal(service.momentsFor(chat.id).length, 0);
	});
	it("keeps distinct selected passages within one message, deduplicates the same selection, and edits only the chosen annotation", () => {
		const { chat, historyStore, service } = fixture({ engine: () => undefined });
		const selection = { blockId: "help-t0", start: 0, end: 8, fingerprint: "0123456789abcdef" };
		const mark = (anchor = selection) => service.mutate({ action: "mark", chatId: chat.id, messageId: "help", selection: anchor, kind: "clicked", surface: "session" });
		mark(); mark();
		assert.equal(service.momentsFor(chat.id).length, 1, "one marker per exact selected range");
		const first = service.momentsFor(chat.id)[0]!;
		mark({ ...selection, start: 12, end: 20 });
		assert.equal(service.momentsFor(chat.id).length, 2);
		service.mutate({ action: "mark", chatId: chat.id, messageId: "help", momentId: first.id, kind: "unsure", note: "I need to revisit this phrase.", surface: "session" });
		const changed = historyStore.read().moments[first.id]!;
		assert.equal(changed.createdAt, first.createdAt); assert.deepEqual(changed.selection, selection);
		assert.equal(changed.kind, "unsure");
		assert.doesNotMatch(JSON.stringify(changed), /puck|friction/, "only position metadata is stored, not a second copy of speech");
		service.mutate({ action: "mark", chatId: chat.id, messageId: "help", momentId: first.id, kind: null, surface: "session" });
		assert.equal(service.momentsFor(chat.id).length, 1);
		assert.equal(service.momentsFor(chat.id)[0]!.selection!.start, 12);
	});
	it("rejects malformed selection coordinates and cross-message marker edits while retaining old whole-message markers", () => {
		const { chat, service } = fixture({ engine: () => undefined });
		const base = { action: "mark", chatId: chat.id, messageId: "help", kind: "clicked", surface: "session" };
		const bad = { blockId: "help-t0", start: 20, end: 10, fingerprint: "0123456789abcdef" };
		assert.throws(() => service.mutate({ ...base, selection: bad }), /Invalid/);
		assert.throws(() => service.mutate({ ...base, selection: { ...bad, start: 0, end: 16001 } }), /Invalid/);
		const marker = service.mutate(base).moments[0]!;
		assert.equal(marker.selection, undefined);
		assert.throws(() => service.mutate({ ...base, messageId: "after", momentId: marker.id, note: "Wrong target" }), /not found/);
		assert.equal(service.momentsFor(chat.id)[0]!.note, "");
	});
	it("cleans only new speech and retains saved strategies and interpretation corrections", async () => {
		const { chat, calls, service } = fixture();
		service.refresh(chat.id); await service.idle();
		const e = service.snapshot().episodes[0]!;
		service.mutate({ action: "correct", episodeId: e.id, text: "I was mixing up acceleration and velocity." });
		service.mutate({ action: "strategy", key: "test a limiting case", saved: true });
		chatStore.saveMessages(chat.id, [...messages, user("new", "The same rule works for circular motion.", 4)]);
		service.refresh(chat.id); await service.idle();
		assert.deepEqual(calls, { clean: 2, analyze: 2 });
		assert.equal(service.snapshot().corrections[e.id], "I was mixing up acceleration and velocity.");
		assert.deepEqual(service.snapshot().savedStrategies, ["test a limiting case"]);
	});
	it("invalidates interpretations when wording changes, while preserving the correction across analysis", async () => {
		const { chat, historyStore, service } = fixture();
		service.refresh(chat.id); await service.idle();
		const offline = createLearningHistoryService({ chatStore, historyStore, engine: () => undefined });
		offline.mutate({ action: "wording", chatId: chat.id, passageId: "before:text:0", text: "I was asking whether continued motion needs a force." });
		assert.equal(offline.snapshot().episodes.length, 0, "stale interpretations must not stay visible");
		service.refresh(chat.id); await service.idle();
		assert.equal(service.snapshot().episodes.length, 1);
		assert.equal(service.snapshot().passages[historyPassageKey(chat.id, "before:text:0")]!.text, "I was asking whether continued motion needs a force.");
	});
	it("does not let a delayed analysis overwrite a newly marked moment", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let entered!: () => void; const began = new Promise<void>(resolve => { entered = resolve; });
		const { chat, service } = fixture({ analyze: async input => { entered(); await gate; return [episode(input)]; } });
		service.refresh(chat.id); await began;
		service.mutate({ action: "mark", chatId: chat.id, messageId: "help", kind: "clicked", note: "This made it clear", surface: "session" });
		release(); await service.idle();
		assert.equal(service.snapshot().moments[0]!.note, "This made it clear");
		assert.equal(service.snapshot().sessions.find(s => s.id === chat.id)!.pending, false);
	});
	it("resumes after failure using completed speech cleanup", async () => {
		let attempts = 0;
		const { chat, calls, service } = fixture({ analyze: async input => { if (!attempts++) throw new Error("Temporary failure"); return [episode(input)]; } });
		service.refresh(chat.id); await service.idle();
		assert.match(service.snapshot().sessions.find(s => s.id === chat.id)!.error!, /Temporary failure/);
		service.refresh(chat.id); await service.idle();
		assert.equal(calls.clean, 1); assert.equal(service.snapshot().episodes.length, 1);
		assert.equal(service.snapshot().sessions.find(s => s.id === chat.id)!.error, null);
	});
	it("cancels safely and does not resurrect a deleted source after an in-flight cleanup", async () => {
		let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
		const { chat, historyStore, service } = fixture({ clean: async input => { await gate; return input.map(p => ({ id: p.id, text: p.text, unclear: [] })); } });
		service.refresh(chat.id); service.cancel(); release(); await service.idle();
		assert.equal(service.snapshot().episodes.length, 0); assert.equal(service.snapshot().status.running, false);
		service.refresh(chat.id); chatStore.deleteChat(chat.id); service.removeSource(chat.id); await service.idle();
		assert.equal(historyStore.read().sources[chat.id], undefined); assert.equal(service.snapshot().episodes.length, 0);
	});
	it("builds cross-session replays and leaves a missing earlier explanation unknown", async () => {
		const { chat, historyStore, service } = fixture();
		service.refresh(chat.id); await service.idle();
		const second = chatStore.createChat("Later physics practice", undefined, { messages: [user("later", "No net force means constant velocity.", 100)] });
		const next = createLearningHistoryService({ chatStore, historyStore, engine: () => ({} as PiEngine), clean: async input => input.map(p => ({ id: p.id, text: p.text, unclear: [] })), analyze: async input => [{ ...episode(cleaned(historyInputPassages({ messages, updatedAt: "2026-01-01" }))), beforeId: null, afterId: input[0]!.id, contextIds: [] }] });
		next.refresh(second.id); await next.idle();
		assert.equal(historyReplayGroups(next.snapshot())[0]!.samples.length, 3);
		const partial = next.snapshot(); partial.episodes = partial.episodes.filter(e => e.chatId === second.id);
		assert.equal(historyReplayGroups(partial)[0]!.samples.length, 1);
	});
	it("does not silently reset a corrupt history file", () => {
		const file = path.join(directory, "broken.json"); fs.writeFileSync(file, "broken");
		assert.throws(() => createLearningHistoryStore(file).read());
		assert.equal(fs.readFileSync(file, "utf8"), "broken");
	});
});
