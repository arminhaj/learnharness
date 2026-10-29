/** Inline explorations use real stores and scripted agents, never a live provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ChatRecord } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { ChatInput } from "../src/core/input-events.ts";
import type { EnabledTools } from "../src/core/pending.ts";
import type { QuestionData } from "../src/core/question-core.ts";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests never call a real provider.");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-inline-exploration-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createExploration, listExplorations, updateExploration } = await import("../src/server/explorations.ts");
const { handleChatInput, handleChatRequest } = await import("../src/server/chat-handler.ts");
const { createExplorationAgent, composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");
const { beginTurn, endTurn, isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { danglingQuestionOf, newUserMessage } = await import("../src/core/native-messages.ts");
const { buildAnswer, dismissedAnswer, normalizeOptions, resolveCorrect } = await import("../src/core/question-core.ts");
const { compactionInFlight, ensureCompacted } = await import("../src/server/compaction.ts");
const explorationRoute = await import("../app/api/chats/[id]/explorations/route.ts");
const explorationActionRoute = await import("../app/api/chats/[id]/explorations/[explorationId]/route.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const question = {
	question: "Which migration command would you run first?",
	options: [{ label: "Choice A" }, { label: "Choice B" }],
	correctAnswer: "SECRET_QUIZ_ANSWER",
	explanation: "SECRET_QUIZ_EXPLANATION",
	type: "check",
	nodeId: "migrations",
};

function lesson(title = "Django migrations"): { chat: ChatRecord; sourceId: string } {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, {
		model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
		thinkingLevel: "high",
	});
	chatStore.saveTree(chat.id, { nodes: [{ id: "migrations", title: "Database migrations" }], edges: [], version: 1 });
	const sourceId = `source_${chat.id}`;
	chatStore.saveMessages(chat.id, [
		newUserMessage("Teach me Django using the project we are building."),
		{
			...fauxAssistantMessage([
				fauxThinking("SECRET_INTERNAL_THINKING"),
				fauxText("A database migration changes the schema while accounting for existing rows."),
				fauxToolCall("quiz", question, { id: `quiz_${chat.id}` }),
			], { stopReason: "toolUse" }),
			id: sourceId,
		} as LhMessage,
	]);
	return { chat: chatStore.getChat(chat.id)!, sourceId };
}

function created(result: ReturnType<typeof createExploration>): ChatRecord {
	assert.ok(result.ok, result.ok ? "" : result.error);
	return result.chat;
}

function open(chatId: string, sourceId: string, topic = "How does a database change a table?"): ChatRecord {
	return created(createExploration(chatId, { sourceMessageId: sourceId, topic }));
}

function inputPost(chatId: string, input: ChatInput): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

function post(chatId: string, text: string): Request {
	return inputPost(chatId, { type: "text", text });
}

function explorationContext(chatId: string) {
	return { chatId, chatStore, jobStore, spawn: () => assert.fail("These scripted lessons must not start a background job") };
}

async function sendInput(engine: PiEngine, chatId: string, input: ChatInput, toolToggles?: EnabledTools): Promise<Response> {
	const response = await handleChatRequest(inputPost(chatId, input), (opts) => {
		assert.equal(opts.teaching, true, "an exploration enters the teacher from its first turn, without probe_done");
		return createExplorationAgent(explorationContext(chatId), { ...opts, engine, ...(toolToggles ? { toolToggles } : {}) });
	});
	if (response.status === 200) {
		const running = runningTurn(chatId);
		if (running) await new Response(running.subscribe()).text();
	}
	return response;
}

async function send(engine: PiEngine, chatId: string, text: string): Promise<Response> {
	return sendInput(engine, chatId, { type: "text", text });
}

describe("inline exploration lifecycle", () => {
	it("inherits the teaching method and tools, without restarting the probe", () => {
		for (const [provider, id, hasOutputAdapter] of [
			["anthropic", "claude-opus-5-5", true],
			["openai", "gpt-4o-mini", false],
		] as const) {
			const { chat, sourceId } = lesson();
			const child = open(chat.id, sourceId);
			const faux = createFauxCore({ provider, models: [{ id }] });
			const agent = createExplorationAgent(explorationContext(child.id), { engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
			const tools = agent.state.tools.map((tool) => tool.name);
			assert.ok(tools.includes("plan_init") && tools.includes("quiz") && tools.includes("ask_user_question"));
			assert.equal(tools.includes("send_to_user"), hasOutputAdapter);
			assert.equal(tools.some((name) => ["probe", "recall", "probe_done", "problem", "conclude"].includes(name)), false);
			assert.ok(agent.state.systemPrompt.includes(composeInstructions("teacher")), "the same teaching instructions govern the branch");
			assert.match(agent.state.systemPrompt, /one reasoning step at a time/);
			const filtered = createExplorationAgent(explorationContext(child.id), {
				engine: { model: faux.getModel(), streamFn: faux.streamSimple }, toolToggles: { plan_init: false },
			});
			assert.equal(filtered.state.tools.some(tool => tool.name === "plan_init"), false,
				"a persisted tool filter stays honored without crashing the branch factory");
		}
	});

	it("honors enabled teaching prompt overrides on each reconstructed exploration turn", () => {
		const { chat, sourceId } = lesson();
		const child = open(chat.id, sourceId);
		const faux = createFauxCore({});
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const segment = "teacher/20-teaching.md";
		try {
			promptOverrides.writeOverride(segment, "CUSTOM BRANCH TEACHING FIRST");
			const first = createExplorationAgent(explorationContext(child.id), { engine, promptSwitches: { [segment]: true } });
			assert.match(first.state.systemPrompt, /CUSTOM BRANCH TEACHING FIRST/);
			promptOverrides.writeOverride(segment, "CUSTOM BRANCH TEACHING UPDATED");
			const second = createExplorationAgent(explorationContext(child.id), { engine, promptSwitches: { [segment]: true } });
			assert.match(second.state.systemPrompt, /CUSTOM BRANCH TEACHING UPDATED/);
			assert.doesNotMatch(second.state.systemPrompt, /CUSTOM BRANCH TEACHING FIRST/);
			const disabled = createExplorationAgent(explorationContext(child.id), { engine, promptSwitches: {} });
			assert.doesNotMatch(disabled.state.systemPrompt, /CUSTOM BRANCH TEACHING/);
		} finally {
			promptOverrides.deleteOverride(segment);
		}
	});

	it("opens from visible context without modifying the paused lesson or revealing question answers", () => {
		const { chat, sourceId } = lesson();
		const before = fs.readFileSync(path.join(process.env.LH_DATA_DIR!, "chats", `${chat.id}.json`), "utf8");
		const child = open(chat.id, sourceId);
		assert.equal(child.exploration?.parentChatId, chat.id);
		assert.equal(child.exploration?.sourceMessageId, sourceId);
		assert.equal(child.exploration?.status, "active");
		assert.deepEqual(child.settings, chat.settings);
		assert.notEqual(child.id, chat.id);
		assert.equal(child.tree, undefined, "the tangent does not inherit a writable lesson plan");
		const seed = JSON.stringify(child.messages);
		assert.match(seed, /database migration changes the schema/);
		assert.doesNotMatch(seed, /SECRET_QUIZ_ANSWER|SECRET_QUIZ_EXPLANATION|SECRET_INTERNAL_THINKING/);
		assert.equal(danglingQuestionOf(child.messages), null, "the parent quiz is not a pending child question");
		assert.equal(fs.readFileSync(path.join(process.env.LH_DATA_DIR!, "chats", `${chat.id}.json`), "utf8"), before);
		assert.deepEqual(chatStore.getChat(chat.id), chat);
	});

	it("accepts successful send_to_user passages while rejecting failed output and excluding hidden content", () => {
		const { chat, sourceId } = lesson();
		const failedId = `failed_${chat.id}`;
		const failedCallId = `failed_send_${chat.id}`;
		const goodCallId = `good_send_${chat.id}`;
		const ack = (toolCallId: string, isError: boolean): LhMessage => ({
			id: `ack_${toolCallId}`, role: "toolResult", toolCallId, toolName: "send_to_user",
			content: [{ type: "text", text: isError ? "Invalid tool input" : "Message received for display." }],
			details: null, isError, timestamp: 1,
		});
		chatStore.saveMessages(chat.id, [
			chat.messages[0]!,
			{ ...fauxAssistantMessage([fauxToolCall("send_to_user", { message: "FAILED_OUTPUT_SECRET" }, { id: failedCallId })],
				{ stopReason: "toolUse" }), id: failedId } as LhMessage,
			ack(failedCallId, true),
			{ ...fauxAssistantMessage([
				fauxThinking("SECRET_INTERNAL_THINKING"),
				fauxToolCall("send_to_user", { message: "A migration can add a nullable column to an existing table." }, { id: goodCallId }),
				fauxToolCall("quiz", question, { id: `quiz_${chat.id}` }),
			], { stopReason: "toolUse" }), id: sourceId } as LhMessage,
			ack(goodCallId, false),
		]);
		const before = chatStore.getChat(chat.id);
		assert.equal(createExploration(chat.id, { sourceMessageId: failedId, topic: "Explore failed prose" }).ok, false);
		const child = open(chat.id, sourceId);
		const seed = JSON.stringify(child.messages);
		assert.match(seed, /add a nullable column/);
		assert.doesNotMatch(seed, /FAILED_OUTPUT_SECRET|SECRET_QUIZ_ANSWER|SECRET_QUIZ_EXPLANATION|SECRET_INTERNAL_THINKING/);
		assert.equal(danglingQuestionOf(child.messages), null);
		assert.deepEqual(chatStore.getChat(chat.id), before);
	});

	it("persists closed explorations in their parent and permits only one active exploration", () => {
		const { chat, sourceId } = lesson();
		const first = open(chat.id, sourceId, "What happens to existing rows?");
		const refused = createExploration(chat.id, { sourceMessageId: sourceId, topic: "What is a schema?" });
		assert.equal(refused.ok, false);
		if (!refused.ok) assert.equal(refused.status, 409);
		assert.equal(listExplorations(chat.id).length, 1);
		assert.equal(created(updateExploration(chat.id, first.id, "close")).exploration?.status, "closed");
		assert.equal(chatStore.getChat(first.id)?.exploration?.status, "closed");
		const second = open(chat.id, sourceId, "What is a schema?");
		const blockedReopen = updateExploration(chat.id, first.id, "reopen");
		assert.equal(blockedReopen.ok, false);
		if (!blockedReopen.ok) assert.equal(blockedReopen.status, 409);
		created(updateExploration(chat.id, second.id, "close"));
		assert.equal(created(updateExploration(chat.id, first.id, "reopen")).exploration?.status, "active");
		assert.equal(listExplorations(chat.id).length, 2, "returning preserves the exploration archive");
		assert.deepEqual(chatStore.getChat(chat.id), chat);
	});

	it("rejects missing anchors, learner-message anchors, empty topics, and nested explorations", () => {
		const { chat, sourceId } = lesson();
		for (const input of [
			{ sourceMessageId: "missing", topic: "A tangent" },
			{ sourceMessageId: chat.messages[0]!.id, topic: "A tangent" },
			{ sourceMessageId: sourceId, topic: "   " },
		]) {
			assert.equal(createExploration(chat.id, input).ok, false);
		}
		assert.equal(listExplorations(chat.id).length, 0);
		const child = open(chat.id, sourceId);
		assert.equal(createExploration(child.id, { sourceMessageId: sourceId, topic: "Nested tangent" }).ok, false);
		assert.deepEqual(chatStore.getChat(chat.id), chat);
	});

	it("does not let a different parent close or reopen another lesson's exploration", () => {
		const first = lesson("First lesson");
		const second = lesson("Second lesson");
		const child = open(first.chat.id, first.sourceId);
		assert.equal(updateExploration(second.chat.id, child.id, "close").ok, false);
		created(updateExploration(first.chat.id, child.id, "close"));
		assert.equal(updateExploration(second.chat.id, child.id, "reopen").ok, false);
		assert.deepEqual(listExplorations(second.chat.id), []);
		assert.deepEqual(chatStore.getChat(first.chat.id), first.chat);
		assert.deepEqual(chatStore.getChat(second.chat.id), second.chat);
	});

	it("refuses opening during a parent turn or background job and returning during a child turn", () => {
		const { chat, sourceId } = lesson();
		beginTurn(chat.id);
		try {
			assert.equal(createExploration(chat.id, { sourceMessageId: sourceId, topic: "A tangent" }).ok, false);
		} finally {
			endTurn(chat.id);
		}
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "research_pending" });
		assert.equal(createExploration(chat.id, { sourceMessageId: sourceId, topic: "A tangent" }).ok, false);
		jobStore.updateJob(job.id, { status: "done" });
		const child = open(chat.id, sourceId);
		beginTurn(child.id);
		try {
			const result = updateExploration(chat.id, child.id, "close");
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.status, 409);
			assert.equal(chatStore.getChat(child.id)?.exploration?.status, "active");
		} finally {
			endTurn(child.id);
		}
		created(updateExploration(chat.id, child.id, "close"));
		assert.deepEqual(chatStore.getChat(chat.id), chat);
	});

	it("blocks parent input and background continuation while paused, and child input after returning", async () => {
		const { chat, sourceId } = lesson();
		const child = open(chat.id, sourceId);
		let built = false;
		const noAgent = () => { built = true; throw new Error("A paused lesson must not construct an agent"); };
		assert.equal((await handleChatRequest(post(chat.id, "Continue the lesson"), noAgent)).status, 409);
		assert.equal((await handleChatInput(chat.id, { type: "steers", steers: [] }, noAgent)).status, 409);
		assert.equal(built, false);
		assert.equal(isTurnRunning(chat.id), false);
		created(updateExploration(chat.id, child.id, "close"));
		const closed = chatStore.getChat(child.id);
		assert.equal((await handleChatRequest(post(child.id, "Continue tangent"), noAgent)).status, 409);
		assert.equal(built, false);
		assert.deepEqual(chatStore.getChat(child.id), closed);
		assert.deepEqual(chatStore.getChat(chat.id), chat);
	});

	it("rejects silent question dismissal while the lesson is paused", async () => {
		const { chat, sourceId } = lesson();
		open(chat.id, sourceId);
		const response = await dismissRoute.POST(new Request("http://test/api/dismiss", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: {
				type: "dismiss", toolCallId: `quiz_${chat.id}`, answer: dismissedAnswer("quiz", question.question),
			} }),
		}), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(response.status, 409);
		assert.deepEqual(chatStore.getChat(chat.id), chat);
		assert.ok(danglingQuestionOf(chatStore.getChat(chat.id)!.messages));
	});

	it("does not open an exploration while the parent history is being compacted", { timeout: 5_000 }, async () => {
		const { chat, sourceId } = lesson();
		chatStore.saveMessages(chat.id, [
			...Array.from({ length: 3 }, (_, index) => newUserMessage(`Earlier material ${index}: ${"x".repeat(100_000)}`)),
			...chat.messages,
		]);
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const faux = createFauxCore({});
		const run = ensureCompacted({
			chatStore,
			engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			modelId: "faux:test", kind: "teach", thresholdTokens: 1, systemPromptTokens: 100,
			summarize: async () => {
				enter();
				await blocked;
				return { summary: "The lesson is about Django migrations.", usage: {
					input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				} };
			},
		}, chat.id);
		await entered;
		try {
			assert.equal(compactionInFlight(chat.id), true);
			const outcome = createExploration(chat.id, { sourceMessageId: sourceId, topic: "A tangent" });
			assert.equal(outcome.ok, false);
			if (!outcome.ok) assert.equal(outcome.status, 409);
			assert.deepEqual(listExplorations(chat.id), []);
		} finally {
			release();
			await run;
		}
		assert.equal(compactionInFlight(chat.id), false);
		assert.equal(open(chat.id, sourceId).exploration?.status, "active");
	});

	it("supports follow-up exploration turns and returns to the exact unanswered lesson", async () => {
		const { chat, sourceId } = lesson();
		const pending = danglingQuestionOf(chat.messages);
		assert.ok(pending);
		const child = open(chat.id, sourceId);
		const contexts: string[] = [];
		const faux = createFauxCore({});
		faux.setResponses([
			(context) => {
				contexts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage([fauxText("A table's structure is its schema.")]);
			},
			(context) => {
				contexts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage([fauxText("Existing rows need values for any new required column.")]);
			},
		]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const agent = createExplorationAgent(explorationContext(child.id), { engine, messages: child.messages });
		assert.equal(agent.state.tools.some((tool) => /^(probe|recall|probe_done|problem|conclude)$/.test(tool.name)), false);
		assert.equal((await send(engine, child.id, "What is a schema?")).status, 200);
		assert.equal((await send(engine, child.id, "What happens to existing rows?")).status, 200);
		assert.equal(contexts.length, 2);
		assert.match(contexts[1]!, /table's structure is its schema/);
		assert.doesNotMatch(contexts.join("\n"), /SECRET_QUIZ_ANSWER|SECRET_QUIZ_EXPLANATION|SECRET_INTERNAL_THINKING/);
		created(updateExploration(chat.id, child.id, "close"));
		const returned = chatStore.getChat(chat.id)!;
		assert.deepEqual(returned, chat);
		assert.deepEqual(danglingQuestionOf(returned.messages), pending);
		assert.match(JSON.stringify(chatStore.getChat(child.id)?.messages), /new required column/);
		assert.equal(chatStore.getChat(child.id)?.exploration?.status, "closed");
	});

	for (const mechanic of ["quiz", "explain"] as const) {
		it(`teaches a child lesson with ${mechanic} checks, preserving its progress and the parent's pending question`, async () => {
			const { chat, sourceId } = lesson();
			const parentFile = path.join(process.env.LH_DATA_DIR!, "chats", `${chat.id}.json`);
			const parentBytes = fs.readFileSync(parentFile, "utf8");
			const parentPending = danglingQuestionOf(chat.messages);
			assert.ok(parentPending);
			const child = open(chat.id, sourceId);
			const firstId = `branch_first_${child.id}`;
			const secondId = `branch_second_${child.id}`;
			const invalidId = `branch_invalid_${child.id}`;
			const options = [{ label: "The table's structure" }, { label: "The stored row values" }];
			const check = {
				type: "check", nodeId: "schema", question: "What is the schema of a table?",
				correctAnswer: "The table's structure",
				...(mechanic === "quiz" ? { options, explanation: "The schema defines columns and their types." } : {}),
			};
			const nextCheck = { ...check, nodeId: "existing-rows", question: "Why does a new column affect existing rows?" };
			const contexts: string[] = [];
			const faux = createFauxCore({});
			faux.setResponses([
				(context) => {
					contexts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage([fauxToolCall("plan_init", {
						mermaid: "graph TD\n  schema[Table structure] --> existing-rows[Existing rows]",
					})], { stopReason: "toolUse" });
				},
				(context) => {
					contexts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage([fauxText("We'll start with a table's structure, then use it to understand existing rows. Shall we begin?")]);
				},
				(context) => {
					contexts.push(JSON.stringify(context.messages));
					// A parent node must never become a valid child check merely
					// because it exists in the paused lesson's map.
					return fauxAssistantMessage([fauxToolCall(mechanic, { ...check, nodeId: "migrations" }, { id: invalidId })], { stopReason: "toolUse" });
				},
				(context) => {
					contexts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage([
						fauxText("A table's schema is its structure: the columns and the kinds of values each column accepts."),
						fauxToolCall(mechanic, check, { id: firstId }),
					], { stopReason: "toolUse" });
				},
				(context) => {
					contexts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage([
						fauxText("Every existing row follows that structure, so adding a column raises the question of what belongs in it for those rows."),
						fauxToolCall(mechanic, nextCheck, { id: secondId }),
					], { stopReason: "toolUse" });
				},
			]);
			const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
			const toolToggles = mechanic === "explain" ? { explain: true } : { explain: false };
			assert.equal((await sendInput(engine, child.id, { type: "text", text: child.exploration!.topic }, toolToggles)).status, 200);
			assert.deepEqual(chatStore.getChat(child.id)!.tree?.nodes.map(node => node.id), ["schema", "existing-rows"]);
			assert.equal(contexts.length, 2, "presenting the branch plan completes its turn before teaching");
			assert.equal(danglingQuestionOf(chatStore.getChat(child.id)!.messages), null);

			assert.equal((await sendInput(engine, child.id, { type: "text", text: "Let's begin." }, toolToggles)).status, 200);
			const firstStep = chatStore.getChat(child.id)!;
			const failed = firstStep.messages.find(message => message.role === "toolResult" && message.toolCallId === invalidId);
			assert.ok(failed?.role === "toolResult" && failed.isError, "the parent-only node is rejected and repaired within the turn");
			const childPending = danglingQuestionOf(firstStep.messages);
			assert.equal(childPending?.tool, mechanic);
			assert.equal(childPending?.toolCallId, firstId);
			assert.equal(contexts.length, 4, "a valid check stops the run until the learner answers");
			assert.equal(firstStep.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && ["probe", "recall", "probe_done"].includes(block.name))), false);

			created(updateExploration(chat.id, child.id, "close"));
			const returnedChild = chatStore.getChat(child.id)!;
			assert.deepEqual(danglingQuestionOf(returnedChild.messages), childPending);
			assert.deepEqual(chatStore.getChat(chat.id), chat);
			assert.deepEqual(danglingQuestionOf(chatStore.getChat(chat.id)!.messages), parentPending);
			created(updateExploration(chat.id, child.id, "reopen"));
			assert.deepEqual(chatStore.getChat(child.id)!.tree, firstStep.tree);
			assert.deepEqual(danglingQuestionOf(chatStore.getChat(child.id)!.messages), childPending);

			const normalized = normalizeOptions(options);
			const qd: QuestionData = {
				id: firstId, kind: mechanic, questionType: "check", question: check.question,
				mode: mechanic === "quiz" ? "single-select" : "text", options: mechanic === "quiz" ? normalized : [],
				...(mechanic === "quiz"
					? { correctIndices: resolveCorrect(check.correctAnswer, normalized).indices }
					: { committedAnswer: check.correctAnswer }),
				createdAt: new Date().toISOString(),
			};
			const answer = buildAnswer(qd, mechanic === "quiz" ? { values: [check.correctAnswer] } : { text: check.correctAnswer }, mechanic);
			const noAgent = () => { throw new Error("A mismatched or paused answer must not construct an agent"); };
			assert.equal((await handleChatRequest(inputPost(child.id, { type: "answer", toolCallId: parentPending.toolCallId, answer }), noAgent)).status, 400);
			assert.equal((await handleChatRequest(inputPost(chat.id, { type: "answer", toolCallId: parentPending.toolCallId, answer }), noAgent)).status, 409);
			assert.equal((await sendInput(engine, child.id, { type: "answer", toolCallId: firstId, answer }, toolToggles)).status, 200);
			const continued = chatStore.getChat(child.id)!;
			assert.equal(danglingQuestionOf(continued.messages)?.toolCallId, secondId);
			assert.equal(contexts.length, 5, "answering advances only the branch to its next step");
			assert.ok(continued.messages.some(message => message.role === "toolResult" && message.toolCallId === firstId && !message.isError));
			assert.doesNotMatch(contexts.join("\n"), /SECRET_QUIZ_ANSWER|SECRET_QUIZ_EXPLANATION|SECRET_INTERNAL_THINKING/);
			created(updateExploration(chat.id, child.id, "close"));
			assert.equal(fs.readFileSync(parentFile, "utf8"), parentBytes, "the main lesson remains byte-for-byte unchanged");
		});
	}
});

describe("inline exploration HTTP routes", () => {
	it("validates request bodies without creating sessions", async () => {
		const { chat, sourceId } = lesson();
		for (const body of ["{", "null", "{}", JSON.stringify({ sourceMessageId: sourceId, topic: 42 }),
			JSON.stringify({ sourceMessageId: sourceId, topic: "x".repeat(2001) })]) {
			const response = await explorationRoute.POST(new Request("http://test/api/explorations", {
				method: "POST", headers: { "Content-Type": "application/json" }, body,
			}), { params: Promise.resolve({ id: chat.id }) });
			assert.equal(response.status, 400);
		}
		assert.deepEqual(listExplorations(chat.id), []);
		assert.deepEqual(chatStore.getChat(chat.id), chat);
	});

	it("keeps explorations out of the sidebar but readable through the parent after returning", async () => {
		const { chat, sourceId } = lesson();
		const response = await explorationRoute.POST(new Request("http://test/api/explorations", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sourceMessageId: sourceId, topic: "How do schema changes affect rows?" }),
		}), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(response.status, 201);
		const { chat: child } = await response.json() as { chat: ChatRecord };
		const sidebar = await (await chatsRoute.GET()).json() as { chats: Array<{ id: string }> };
		assert.ok(sidebar.chats.some((item) => item.id === chat.id));
		assert.ok(!sidebar.chats.some((item) => item.id === child.id));
		assert.ok(chatStore.listChats().some((item) => item.id === child.id), "internal enumeration still includes extraction sources");
		const action = (body: unknown) => explorationActionRoute.POST(new Request("http://test/api/exploration-action", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
		}), { params: Promise.resolve({ id: chat.id, explorationId: child.id }) });
		assert.equal((await action({ action: "delete-everything" })).status, 400);
		assert.equal((await action({ action: "close" })).status, 200);
		const listed = await (await explorationRoute.GET(new Request("http://test/api/explorations"),
			{ params: Promise.resolve({ id: chat.id }) })).json() as { explorations: ChatRecord[] };
		assert.equal(listed.explorations[0]?.id, child.id);
		assert.equal(listed.explorations[0]?.exploration?.status, "closed");
		assert.deepEqual(chatStore.getChat(chat.id), chat);
	});
});
