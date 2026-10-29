import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ChatRecord, GraphNode } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { initialModelProgress, advanceModelProgress, type ModelStreamProgress, type ExtractionProgress } from "../src/core/extraction-progress.ts";
import { buildLearningGraphSnapshot, emptyLearningGraphState, mergeLearningContribution } from "../src/core/learning-graph.ts";
import { createExtractionPipeline, createExtractionProgressNotifier, extractionStatuses } from "../src/agent/subagents/extraction.ts";
import { modelProgressEvent, runSubagent } from "../src/agent/subagents/pi-run.ts";

describe("redacted extraction progress", () => {
	it("counts real deltas and does not fabricate activity for a new turn", () => {
		let progress = initialModelProgress(8);
		assert.equal(progress.requestStartedAt, undefined, "queued work has not started a model request");
		progress = advanceModelProgress(progress, { kind: "turn-start" }, 100);
		assert.equal(progress.modelTurn, 1);
		assert.equal(progress.requestStartedAt, 100);
		assert.equal(progress.lastActivityAt, 0);
		assert.equal(progress.receivedEvents, 0, "starting a request is not a received provider event");
		progress = advanceModelProgress(progress, { kind: "stream-start" }, 120);
		progress = advanceModelProgress(progress, { kind: "thinking", characters: 12 }, 140);
		progress = advanceModelProgress(progress, { kind: "responding", characters: 20 }, 160);
		assert.equal(progress.lastActivityAt, 160);
		assert.equal(progress.receivedEvents, 3);
		assert.equal(progress.outputChars, 32);
		progress = advanceModelProgress(progress, { kind: "tool", toolName: "arbitrary model text" }, 170);
		assert.equal(progress.toolName, undefined);
		assert.equal(progress.receivedEvents, 3, "local tools are activity, not provider events");
		progress = advanceModelProgress(progress, { kind: "turn-start" }, 900);
		assert.equal(progress.requestStartedAt, 900);
		assert.equal(progress.lastActivityAt, 170);
		assert.equal(progress.modelTurn, 2);
		assert.equal(progress.outputChars, 32);
	});

	it("drops raw reasoning, tool arguments/results and arbitrary tool names at the adapter", () => {
		const secret = "PRIVATE SOURCE AND REASONING";
		const partial = fauxAssistantMessage([{ type: "thinking", thinking: secret }]);
		const events: AgentEvent[] = [
			{ type: "message_update", message: partial, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: secret, partial } },
			{ type: "tool_execution_start", toolCallId: "private-call-id", toolName: "find_learning_concepts", args: { query: secret } },
			{ type: "tool_execution_end", toolCallId: "private-call-id", toolName: secret, result: { content: secret }, isError: false },
		];
		const redacted = events.map(modelProgressEvent);
		assert.deepEqual(redacted[0], { kind: "thinking", characters: secret.length });
		assert.equal(redacted[1]?.kind, "tool");
		assert.equal("toolName" in redacted[1]! && redacted[1]!.toolName, "find_learning_concepts");
		assert.doesNotMatch(JSON.stringify(redacted), /PRIVATE|private-call-id|query|result|thinking_delta/);
	});

	it("reports streamed reasoning before the assistant response completes", async () => {
		const stream = new AssistantMessageEventStream();
		const faux = createFauxCore({});
		const updates: ModelStreamProgress[] = [];
		let modelStarted!: () => void;
		const started = new Promise<void>((resolve) => { modelStarted = resolve; });
		let sawDelta!: () => void;
		const deltaSeen = new Promise<void>((resolve) => { sawDelta = resolve; });
		let messagesCompleted = 0;
		const running = runSubagent([], {
			role: "extractor", systemPrompt: "Test only", prompt: "Synthetic input", maxTurns: 1,
			engine: { model: faux.getModel(), streamFn: () => { modelStarted(); return stream; } },
			onProgress: (progress) => { updates.push(progress); if (progress.outputChars > 0) sawDelta(); },
			onAssistantMessage: () => { messagesCompleted++; },
		});
		await started;
		const partial = fauxAssistantMessage([{ type: "thinking", thinking: "secret reasoning" }]);
		stream.push({ type: "start", partial });
		stream.push({ type: "thinking_delta", contentIndex: 0, delta: "secret reasoning", partial });
		await deltaSeen;
		assert.equal(messagesCompleted, 0);
		assert.equal(updates.at(-1)!.activity, "thinking");
		assert.equal(updates.at(-1)!.outputChars, "secret reasoning".length);
		assert.equal(updates.at(-1)!.modelTurn, 1);
		assert.ok(updates.at(-1)!.lastActivityAt > 0);
		assert.doesNotMatch(JSON.stringify(updates), /secret reasoning|Synthetic input/);
		const final = fauxAssistantMessage("Finished", { stopReason: "stop" });
		stream.push({ type: "done", reason: "stop", message: final });
		stream.end(final);
		await running;
		assert.equal(messagesCompleted, 1);
	});

	it("throttles notifications with a trailing flush without changing activity timestamps", () => {
		let now = 1000;
		let activityAt = 1000;
		const published: { at: number; activityAt: number }[] = [];
		const timers = new Map<number, { callback: () => void; at: number }>();
		let counter = 0;
		const notifier = createExtractionProgressNotifier(() => published.push({ at: now, activityAt }), {
			now: () => now,
			schedule: (callback, delay) => { const id = ++counter; timers.set(id, { callback, at: now + delay }); return id as unknown as ReturnType<typeof setTimeout>; },
			cancel: (id) => { timers.delete(id as unknown as number); },
		});
		notifier.changed();
		now = 1100; activityAt = now; notifier.changed();
		now = 1200; activityAt = now; notifier.changed();
		assert.equal(published.length, 1);
		assert.equal(timers.size, 1);
		const [id, timer] = [...timers][0]!;
		assert.equal(timer.at, 2000);
		now = timer.at; timers.delete(id); timer.callback();
		assert.deepEqual(published, [{ at: 1000, activityAt: 1000 }, { at: 2000, activityAt: 1200 }]);
		assert.equal(timers.size, 0, "idle time alone never schedules a heartbeat");
		now = 2100; notifier.changed(); notifier.cancel();
		assert.equal(timers.size, 0);
	});
});

describe("learning source batch progress", () => {
	it("carries completed batches and last-save counts into a later waiting batch", async () => {
		const date = "2026-10-20T12:00:00.000Z";
		const node: GraphNode = { id: "n_progress_fixture", name: "Growth", statement: "Growth relates change to amount.", createdAt: date, aliases: [], provenance: [] };
		const chat: ChatRecord = {
			id: "learning_progress_batches", title: "Progress fixture", createdAt: date, updatedAt: date,
			messages: [1, 2, 3].map((index) => ({ id: `u${index}`, role: "user", content: `Private learner statement ${index}. `.repeat(10), timestamp: Date.parse(date) + index })),
		};
		let state = emptyLearningGraphState();
		const snapshots: ExtractionProgress[] = [];
		const faux = createFauxCore({});
		faux.setResponses([1, 2, 3].map(() => () => {
			const active = extractionStatuses().find((run) => run.chatId === chat.id)!;
			snapshots.push(structuredClone(active.progress!));
			return fauxAssistantMessage([fauxToolCall("submit_learning_map", {
				concepts: [], nodes: [{ nodeId: node.id, tags: ["math"], symbols: [], progressEvidence: [] }], prerequisites: [],
				groups: [{ id: "progress-group", name: "Growth", description: "Growth ideas", members: [node.id] }],
			} as ToolCall["arguments"])], { stopReason: "toolUse" });
		}));
		const pipeline = createExtractionPipeline({
			chatStore: { getChat: () => chat, appendExtractionUsage: () => undefined } as unknown as ChatStore,
			graphStore: {} as GraphStore, getChunkTokens: () => 10,
			extractor: { model: faux.getModel(), streamFn: faux.streamSimple },
			learning: { readState: () => state, snapshot: () => buildLearningGraphSnapshot([node], state), saveContribution: (contribution) => { state = mergeLearningContribution(state, contribution); } },
		});
		await pipeline.updateLearning!(chat.id);
		assert.equal(snapshots.length, 3);
		assert.deepEqual(snapshots.map((snapshot) => snapshot.batch), [
			{ current: 1, total: 3, completed: 0 }, { current: 2, total: 3, completed: 1 }, { current: 3, total: 3, completed: 2 },
		]);
		assert.equal(new Set(snapshots.map((snapshot) => snapshot.sourceStartedAt)).size, 1);
		assert.equal(snapshots[0]!.lastSavedAt, undefined);
		assert.ok(snapshots[1]!.lastSavedAt! >= snapshots[0]!.sourceStartedAt);
		assert.deepEqual(snapshots[2]!.saved, { nodes: 1, prerequisites: 0, groups: 1 }, "same ids count once across batches");
		assert.equal(snapshots[1]!.receivedEvents, 0);
		assert.equal(snapshots[1]!.lastActivityAt, 0, "new batch is honestly waiting for its first model response");
		assert.doesNotMatch(JSON.stringify(snapshots), /Private learner|Growth ideas/);
		assert.equal(extractionStatuses().some((run) => run.chatId === chat.id), false);
	});
});
