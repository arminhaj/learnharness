import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createInlineExploration, changeInlineExploration, explorationErrorMessage, InlineExploration, useInlineExplorations, type ExplorationRecord } from "../components/inline-exploration.tsx";
import { planBlocksFor } from "../src/core/plan-blocks.ts";
import { latestTree } from "../components/plan-block.tsx";
import type { LhViewMessage } from "../src/core/view.ts";
import { buildSubagentSteer, type JobRecord } from "../src/core/contracts/jobs.ts";
import { QuestionDock } from "../components/question-dock.tsx";
import { readPathInput } from "../components/path-input-dom.ts";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { useChatSession } from "../components/session.ts";
import { messageIdFromHash, propositionSessionHref } from "../src/core/session-navigation.ts";
import { buildAnswer, newAnswerResult } from "../src/core/index.ts";

const chat: ExplorationRecord & { turnInFlight: boolean } = {
	id: "child", title: "Why does this happen?", createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", messages: [],
	turnInFlight: false,
	exploration: { parentChatId: "lesson", sourceMessageId: "m_source", parentTitle: "Django", topic: "Why does this happen?", status: "closed" },
};

describe("inline exploration transport", () => {
	it("displays model setup errors as readable guidance instead of a JSON envelope", () => {
		assert.equal(explorationErrorMessage(JSON.stringify({ error: "Models missing", code: "models_not_configured", missing: ["strong"] })), "Set up your models in Settings to continue exploring.");
		assert.equal(explorationErrorMessage(JSON.stringify({ error: "Wait for the current response." })), "Wait for the current response.");
		assert.equal(explorationErrorMessage("Connection failed"), "Connection failed");
	});
	it("creates only a child at the selected source; it does not submit or dismiss the lesson's question", async () => {
		const calls: { url: string; body: unknown }[] = [];
		const request = (async (url: string, init: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init.body)) });
			return Response.json({ chat }, { status: 201 });
		}) as typeof fetch;
		assert.deepEqual(await createInlineExploration("lesson", "m_source", "  Why does this happen?  ", request), chat);
		assert.deepEqual(calls, [{ url: "/api/chats/lesson/explorations", body: { sourceMessageId: "m_source", topic: "Why does this happen?" } }]);
	});
	it("return closes only the exploration and propagates a busy refusal so the UI keeps it open", async () => {
		const calls: unknown[] = [];
		const request = (async (url: string, init: RequestInit) => {
			calls.push([url, JSON.parse(String(init.body))]);
			return Response.json({ error: "Wait for the current response to finish first." }, { status: 409 });
		}) as typeof fetch;
		await assert.rejects(changeInlineExploration("lesson", "child", "close", request), /Wait for the current response/);
		assert.deepEqual(calls, [["/api/chats/lesson/explorations/child", { action: "close" }]]);
	});
	it("reopening targets the existing child, preserving its conversation", async () => {
		let sent: unknown;
		const request = (async (_url: string, init: RequestInit) => {
			sent = JSON.parse(String(init.body));
			return Response.json({ chat: { ...chat, exploration: { ...chat.exploration, status: "active" } } });
		}) as typeof fetch;
		assert.equal((await changeInlineExploration("lesson", "child", "reopen", request)).id, "child");
		assert.deepEqual(sent, { action: "reopen" });
	});
});

describe("inline exploration archive", () => {
	it("anchors learner evidence and teacher passages to exact native messages inside the parent lesson", () => {
		const learnerId = "child_learner";
		const teacherId = "child_teacher";
		const record: ExplorationRecord = { ...chat, messages: [
			{ id: learnerId, role: "user", content: [{ type: "text", text: "My explanation." }, { type: "text", text: "My supporting reasoning." }], timestamp: 1 },
			{ ...fauxAssistantMessage([fauxText("A useful follow-up."), fauxText("Another paragraph.")]), id: teacherId },
		] };
		const html = renderToStaticMarkup(<ServerEventsProvider connect={quietEvents}><InlineExploration chat={record} expanded changing={false} canReopen onInitialDelivered={() => {}} onToggle={() => {}} onClose={() => {}} onReopen={() => {}} /></ServerEventsProvider>);
		for (const messageId of [learnerId, teacherId]) {
			const href = propositionSessionHref({ provenance: [{ chatId: record.id, subjectId: record.exploration.parentChatId, messageId }] }, record.id);
			assert.equal(href, `/chat/lesson?exploration=child#message-${messageId}`);
			assert.equal(messageIdFromHash(href.slice(href.indexOf("#"))), messageId);
			assert.equal(html.split(`id="message-${messageId}"`).length - 1, 1, "exactly one target for each native message, even with multiple text parts");
		}
		assert.match(html, /My explanation/);
		assert.match(html, /My supporting reasoning/);
	});
	it("keeps a returned exploration as a collapsed block rather than navigating to another chat", () => {
		const html = renderToStaticMarkup(<InlineExploration chat={chat} expanded={false} changing={false} canReopen onInitialDelivered={() => {}} onToggle={() => {}} onClose={() => {}} onReopen={() => {}} />);
		assert.match(html, /data-exploration-id="child"/);
		assert.match(html, /aria-expanded="false"/);
		assert.match(html, /Why does this happen\?/);
		assert.doesNotMatch(html, /href=|data-testid="composer"|exploration-transcript/);
	});
});

describe("lesson question stays paused in place", () => {
	it("preserves the same answer field and draft, blocks global Enter, and resumes after return", async () => {
		const dom = parseHTML("<html><body></body></html>");
		const saved = new Map<string, PropertyDescriptor | undefined>();
		for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
			saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		const submitted: unknown[] = [];
		const render = (paused: boolean) => act(async () => root.render(<QuestionDock
			toolName="ask_user_question" toolCallId="q_waiting" input={{ question: "Explain the request lifecycle." }}
			expanded paused={paused} dictationClaim={false} initialDraft={{ text: "My unfinished explanation", selection: { selected: new Set(), otherSelected: false, dontKnow: false }, thinking: "", other: "", confidenceIndex: 2 }}
			onExpand={() => {}} onSubmit={answer => submitted.push(answer)} />));
		const enter = () => {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "Enter" });
			window.dispatchEvent(event);
		};
		try {
			await render(false);
			const field = host.querySelector<HTMLElement>('[data-file-path-input][aria-label="Type your answer…"]')!;
			assert.equal(readPathInput(field), "My unfinished explanation");
			await render(true);
			assert.equal(host.querySelector<HTMLElement>('[data-file-path-input][aria-label="Type your answer…"]'), field, "pausing did not remount the learner's field");
			await act(async () => enter());
			assert.equal(submitted.length, 0, "exploration keys cannot answer the lesson question");
			assert.equal(readPathInput(field), "My unfinished explanation");
			await render(false);
			assert.equal(host.querySelector<HTMLElement>('[data-file-path-input][aria-label="Type your answer…"]'), field, "returning preserved the exact field");
			await act(async () => enter());
			assert.equal(submitted.length, 1, "the original question is answerable again after returning");
		} finally {
			await act(async () => root.unmount()); host.remove();
			for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
		}
	});
});

const quietEvents = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });

async function withExplorationDOM(run: (host: HTMLElement, root: ReturnType<typeof createRoot>) => Promise<void>) {
	const dom = parseHTML("<html><body></body></html>");
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLInputElement: dom.window.HTMLInputElement,
		location: { href: "http://localhost/chat/lesson", hash: "" }, IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () => ({ display: "block", animationName: "none" }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle) })) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const savedFetch = globalThis.fetch;
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try { await run(host, root); }
	finally {
		await act(async () => root.unmount()); host.remove(); globalThis.fetch = savedFetch;
		for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
	}
}

describe("exploration request races", () => {
	it("a running reconciliation cannot reattach over an input started before React renders its busy state", async () => {
		await withExplorationDOM(async (_host, root) => {
			let session!: ReturnType<typeof useChatSession>;
			let finishPost!: (response: Response) => void;
			let posts = 0;
			let streams = 0;
			globalThis.fetch = (async (url: string) => {
				if (url === "/api/chat") { posts++; return new Promise<Response>(resolve => { finishPost = resolve; }); }
				if (url.endsWith("/stream")) { streams++; throw new Error("A notification must not replace the admitted input's reader."); }
				return Response.json({ ...chat, turnInFlight: true });
			}) as typeof fetch;
			function Fixture() { session = useChatSession({ chatId: "child", initialMessages: [] }); return null; }
			await act(async () => root.render(<Fixture />));
			await act(async () => {
				const beforeRender = session;
				assert.equal(await beforeRender.reconcileTurn(), "running");
				const sending = beforeRender.send({ type: "text", text: "My new answer." });
				assert.equal(beforeRender.status, "ready", "the React snapshot is still idle");
				assert.equal(beforeRender.resumeStreamIfIdle(), false, "the current model already owns the newer input");
				finishPost(Response.json({ error: "Offline for this test." }, { status: 503 }));
				await sending;
			});
			assert.equal(posts, 1);
			assert.equal(streams, 0);
		});
	});
	for (const notification of ["turn-settled", "resync"] as const) {
		it(`${notification} recovers a completed exploration whose stream never delivered a terminal`, async () => {
			await withExplorationDOM(async (host, root) => {
				const record: ExplorationRecord = { ...chat, exploration: { ...chat.exploration, status: "active" }, messages: [
					{ ...fauxAssistantMessage([{ type: "thinking", thinking: "An earlier available summary." }, fauxText("Earlier explanation.")]), id: "earlier" },
					{ id: "learner", role: "user", content: [{ type: "text", text: "A follow-up answer." }], timestamp: 2 },
				] };
				const completed: ExplorationRecord = { ...record, messages: [...record.messages,
					{ ...fauxAssistantMessage([fauxText("The completed response.")]), id: "completed" },
				] };
				let running = true;
				let streams = 0;
				let cancellations = 0;
				let writes = 0;
				const handlers = new Map<string, (raw: string) => void>();
				let reopened = () => {};
				const source: NotifySource = { close() {}, onOpen(callback) { reopened = callback; }, onEvent(name, callback) { handlers.set(name, callback); } };
				const notify = () => notification === "resync" ? reopened() : handlers.get("turn-settled")!(JSON.stringify({ chatId: "child" }));
				globalThis.fetch = (async (url: string, init?: RequestInit) => {
					if (init?.method === "POST") { writes++; throw new Error("Recovery must never submit an input."); }
					if (url.startsWith("/api/jobs")) return Response.json({ jobs: [] });
					if (url.endsWith("/explorations")) return Response.json({ explorations: [] });
					if (url.endsWith("/stream")) {
						streams++;
						return new Response(new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "message_start", message: fauxAssistantMessage([{ type: "thinking", thinking: "" }]) })}\n\n`));
							},
							cancel() { cancellations++; },
						}));
					}
					return Response.json({ ...(running ? record : completed), turnInFlight: running });
				}) as typeof fetch;
				await act(async () => root.render(<ServerEventsProvider connect={() => source}>
					<InlineExploration chat={record} expanded changing={false} canReopen onInitialDelivered={() => {}} onToggle={() => {}} onClose={() => {}} onReopen={() => {}} />
				</ServerEventsProvider>));
				assert.equal(streams, 1);
				assert.equal(host.querySelectorAll('[aria-label="Working"]').length, 1, "only the blank live response has a working indicator");
				const summary = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Reasoning summary"));
				assert.ok(summary, "an older summary stays completed while the current response runs");
				assert.equal(summary.getAttribute("aria-expanded"), "false");
				assert.equal([...host.querySelectorAll("button")].some(button => button.textContent?.includes("Working")), false, "the empty live response has no disclosure");
				await act(async () => notify());
				assert.equal(cancellations, 0, "a notification cannot cancel a response the server still owns");
				assert.equal(streams, 1, "a running response keeps its existing reader");
				running = false;
				await act(async () => notify());
				assert.equal(cancellations, 1, "only the stale view reader is released");
				assert.equal(writes, 0);
				assert.equal(streams, 1);
				assert.match(host.textContent ?? "", /The completed response\./);
				assert.equal(host.querySelector('[aria-label="Working"]'), null);
				const returnButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Return to lesson"));
				assert.equal(returnButton?.disabled, false, "server-confirmed completion releases the exploration controls");
			});
		});
	}
	it("reopening an older exploration preserves chronological sibling order", async () => {
		await withExplorationDOM(async (_host, root) => {
			const newer: ExplorationRecord = { ...chat, id: "newer", createdAt: "2026-10-29T01:00:00Z" };
			const reopened: ExplorationRecord = { ...chat, exploration: { ...chat.exploration, status: "active" } };
			globalThis.fetch = (async (_url: string, init?: RequestInit) => init?.method === "POST"
				? Response.json({ chat: reopened })
				: Response.json({ explorations: [chat, newer] })) as typeof fetch;
			let state!: ReturnType<typeof useInlineExplorations>;
			function Fixture() { state = useInlineExplorations("lesson"); return null; }
			await act(async () => root.render(<ServerEventsProvider connect={quietEvents}><Fixture /></ServerEventsProvider>));
			await act(async () => { assert.equal(await state.change(chat, "reopen"), true); });
			assert.deepEqual(state.records.map(record => record.id), ["child", "newer"]);
			assert.equal(state.records[0]!.exploration.status, "active");
		});
	});
	it("an older list response cannot reopen a child after Return to lesson succeeds", async () => {
		await withExplorationDOM(async (_host, root) => {
			const activeChat: ExplorationRecord = { ...chat, exploration: { ...chat.exploration, status: "active" } };
			let stale: ((response: Response) => void) | undefined;
			let deferList = false;
			globalThis.fetch = (async (_url: string, init?: RequestInit) => {
				if (init?.method === "POST") return Response.json({ chat });
				if (deferList) return new Promise<Response>(resolve => { stale = resolve; });
				return Response.json({ explorations: [activeChat] });
			}) as typeof fetch;
			let state!: ReturnType<typeof useInlineExplorations>;
			function Fixture() { state = useInlineExplorations("lesson"); return <span>{state.active?.id ?? "returned"}</span>; }
			await act(async () => root.render(<ServerEventsProvider connect={quietEvents}><Fixture /></ServerEventsProvider>));
			assert.equal(state.active?.id, "child");
			deferList = true;
			const pendingList = state.load();
			await act(async () => { assert.equal(await state.change(activeChat, "close"), true); });
			assert.equal(state.active, undefined);
			await act(async () => { stale!(Response.json({ explorations: [activeChat] })); await pendingList; });
			assert.equal(state.active, undefined, "stale pre-close data was ignored");
		});
	});
	it("sends the opening question once when a list notification mounts the child before create resolves", async () => {
		await withExplorationDOM(async (_host, root) => {
			const activeChat: ExplorationRecord = { ...chat, exploration: { ...chat.exploration, status: "active" } };
			const inputs: unknown[] = [];
			globalThis.fetch = (async (url: string, init?: RequestInit) => {
				if (url.endsWith("/explorations")) return Response.json({ explorations: [] });
				if (url === "/api/chat") {
					inputs.push(JSON.parse(String(init?.body)));
					return Response.json({ error: "Models are not configured." }, { status: 503 });
				}
				return Response.json(activeChat);
			}) as typeof fetch;
			const render = (initialPrompt?: string) => act(async () => root.render(<ServerEventsProvider connect={quietEvents}>
				<InlineExploration chat={activeChat} expanded changing={false} canReopen={false} initialPrompt={initialPrompt}
					onInitialDelivered={() => {}} onToggle={() => {}} onClose={() => {}} onReopen={() => {}} />
			</ServerEventsProvider>));
			await render();
			assert.equal(inputs.length, 0, "discovering a child alone never dispatches a model turn");
			await render("Why does this happen?");
			assert.equal(inputs.length, 1, "the create response's later opening prompt was delivered");
			await render("Why does this happen?");
			assert.equal(inputs.length, 1, "rerendering does not retry the failed opening automatically");
		});
	});
});


function teachingBranch(tool = "quiz", type = "check"): ExplorationRecord {
	return { ...chat, exploration: { ...chat.exploration, status: "active" }, messages: [
		{ id: "child_user", role: "user", content: [{ type: "text", text: "Help me understand schemas." }], timestamp: 1 },
		{ ...fauxAssistantMessage([fauxText("A schema describes a table's structure."), fauxToolCall(tool, {
			question: "What does a schema describe?", type, nodeId: "schema",
			...(tool === "quiz" ? { options: [{ label: "Table structure" }, { label: "A particular row" }], correctAnswer: "Table structure", explanation: "It describes the structure." } : { correctAnswer: "The table structure." }),
		}, { id: "child_check" })], { stopReason: "toolUse" }), id: "child_teacher" },
	] };
}

function renderBranch(root: ReturnType<typeof createRoot>, record: ExplorationRecord, expanded = true, onClose = () => {}) {
	return act(async () => root.render(<ServerEventsProvider connect={quietEvents}>
		<InlineExploration chat={record} expanded={expanded} changing={false} canReopen onInitialDelivered={() => {}} onToggle={() => {}} onClose={onClose} onReopen={() => {}} />
	</ServerEventsProvider>));
}

function mockBranchRequests(record: ExplorationRecord, inputs: Array<{ chatId: string; input: { type: string; toolCallId?: string } }> = []) {
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (url.startsWith("/api/jobs")) return Response.json({ jobs: [] });
		if (url.endsWith("/explorations")) return Response.json({ explorations: [] });
		if (url === "/api/chat") {
			inputs.push(JSON.parse(String(init?.body)));
			return Response.json({ error: "Offline for this test." }, { status: 503 });
		}
		return Response.json(record);
	}) as typeof fetch;
}

describe("exploration teaching controls", () => {
	it("offers an explicit response retry after a saved choice receives an empty completion", async () => {
		await withExplorationDOM(async (host, root) => {
			const choice = "Continue the derivation";
			const answer = buildAnswer({ id: "choice", kind: "ask", question: "What should we explore?", mode: "single-select", options: [{ label: choice, value: "continue" }], createdAt: "fixture" }, { values: ["continue"] });
			const record: ExplorationRecord = { ...chat, exploration: { ...chat.exploration, status: "active" }, messages: [
				{ id: "learner", role: "user", content: [{ type: "text", text: "Help me understand this derivation." }], timestamp: 1 },
				{ ...fauxAssistantMessage([fauxToolCall("ask_user_question", { question: "What should we explore?", options: [{ label: choice, value: "continue" }] }, { id: "choice" })], { stopReason: "toolUse" }), id: "question" },
				newAnswerResult("choice", "ask_user_question", answer),
				{ ...fauxAssistantMessage([{ type: "thinking", thinking: "" }, fauxText("")], { stopReason: "stop" }), id: "empty" },
			] };
			const original = JSON.stringify(record);
			const inputs: Array<{ chatId: string; input: { type: string; toolCallId?: string } }> = [];
			mockBranchRequests(record, inputs);
			await renderBranch(root, record);
			assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /The model finished without an answer\. Your input is saved\./);
			assert.match(host.textContent ?? "", /Continue the derivation/);
			assert.equal(host.querySelector('[role="radio"]'), null, "the saved choice is not requested again");
			assert.equal(host.querySelector('[aria-label="Working"]'), null, "a completed empty reply is no longer presented as working");
			assert.equal(inputs.length, 0, "opening the exploration never retries inference");
			const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry response");
			assert.ok(retry);
			await act(async () => retry.click());
			assert.deepEqual(inputs, [{ chatId: "child", input: { type: "retry" } }], "retry reuses the saved input instead of submitting the choice twice");
			assert.equal(JSON.stringify(record), original, "the failed attempt and original input remain in the record");
		});
	});
	for (const delivered of [false, true]) {
		it(`restores a ${delivered ? "delivered" : "pending"} figure and its brightness preference after reload`, async () => {
			await withExplorationDOM(async (host, root) => {
				const record = teachingBranch("explain");
				const job: JobRecord = { id: "job_saved", chatId: "child", kind: "visual", toolCallId: "figure_call", status: "done", activity: "finished", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", delivery: { kind: "result", status: delivered ? "delivered" : "pending" }, result: { svg: "<svg/>" }, ui: { inverted: true } };
				if (delivered) record.messages.push(buildSubagentSteer(job, job.result as { svg: string }));
				const writes: string[] = [];
				globalThis.fetch = (async (url: string, init?: RequestInit) => {
					if (init?.method === "POST") writes.push(url);
					if (url.endsWith("/explorations")) return Response.json({ explorations: [] });
					return Response.json(url.startsWith("/api/jobs") ? { jobs: [job] } : record);
				}) as typeof fetch;
				await renderBranch(root, record);
				assert.equal(host.querySelectorAll('[data-testid="visual-card"]').length, 1);
				assert.match(host.querySelector('[data-testid="visual-svg"]')!.getAttribute("style")!, /invert\(1\)/);
				assert.ok(host.querySelector('[data-testid="teach-check-reveal"]'));
				assert.deepEqual(writes, []);
			});
		});
	}

	it("shows a finished figure while a question waits, then adopts its delivery without duplicating or remounting it", async () => {
		await withExplorationDOM(async (host, root) => {
			const record = teachingBranch("explain");
			record.messages.splice(1, 0,
				{ ...fauxAssistantMessage([fauxToolCall("visual", { brief: "Draw the schema." }, { id: "figure_call" })]), id: "figure_request" },
				{ id: "figure_ack", role: "toolResult", toolCallId: "figure_call", toolName: "visual", content: [{ type: "text", text: "Dispatched" }], details: "Dispatched", isError: false, timestamp: 2 },
			);
			let job: JobRecord = { id: "job_figure", chatId: "child", kind: "visual", toolCallId: "figure_call", status: "running", activity: "drawing", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" };
			const events = new Map<string, (data: string) => void>();
			const connect = (): NotifySource => ({ close() {}, onOpen() {}, onEvent(name, cb) { events.set(name, cb); } });
			const writes: string[] = [];
			globalThis.fetch = (async (url: string, init?: RequestInit) => {
				if (init?.method === "POST") writes.push(url);
				if (url.endsWith("/explorations")) return Response.json({ explorations: [] });
				return Response.json(url.startsWith("/api/jobs") ? { jobs: [job] } : record);
			}) as typeof fetch;
			await act(async () => root.render(<ServerEventsProvider connect={connect}>
				<InlineExploration chat={record} expanded changing={false} canReopen onInitialDelivered={() => {}} onToggle={() => {}} onClose={() => {}} onReopen={() => {}} />
			</ServerEventsProvider>));
			const question = host.querySelector('[data-testid="teach-check-reveal"]');
			assert.ok(question);
			assert.equal(host.querySelector('[data-testid="visual-card"]'), null);
			job = { ...job, status: "done", activity: "finished", delivery: { kind: "result", status: "pending" }, result: { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text>Schema</text></svg>' } };
			await act(async () => events.get("jobs-changed")!(JSON.stringify({ chatId: "child" })));
			const figure = host.querySelector('[data-testid="visual-card"]');
			assert.ok(figure, "worker completion displays the saved SVG without answering the question");
			assert.equal(host.querySelector('[data-testid="teach-check-reveal"]'), question);
			assert.deepEqual(writes, [], "showing the result does not submit an answer or start a tutor turn");
			await act(async () => (host.querySelector('[aria-label="Invert figure brightness"]') as HTMLElement).click());
			assert.deepEqual(writes, ["/api/chats/child/artifact-ui"]);
			// Delivery status may reach the job feed before the transcript does.
			job = { ...job, delivery: { kind: "result", status: "delivered" } };
			await act(async () => events.get("jobs-changed")!(JSON.stringify({ chatId: "child" })));
			assert.equal(host.querySelector('[data-testid="visual-card"]'), figure);
			record.messages.push(buildSubagentSteer(job, job.result as { svg: string }));
			await act(async () => events.get("record-changed")!(JSON.stringify({ chatId: "child" })));
			assert.equal(host.querySelectorAll('[data-testid="visual-card"]').length, 1);
			assert.equal(host.querySelector('[data-testid="visual-card"]'), figure, "the canonical delivery retains the mounted figure and its controls");
			assert.match(host.querySelector('[data-testid="visual-svg"]')!.getAttribute("style")!, /invert\(1\)/);
		});
	});

	it("reveals child checks after teaching and preserves the exact selected answer across returning and reopening", async () => {
		await withExplorationDOM(async (host, root) => {
			const record = teachingBranch();
			const inputs: Array<{ chatId: string; input: { type: string; toolCallId?: string } }> = [];
			mockBranchRequests(record, inputs);
			await renderBranch(root, record);
			assert.ok(host.textContent?.includes("A schema describes a table's structure."));
			assert.ok(host.querySelector('[data-testid="teach-check-reveal"]'));
			assert.ok(host.querySelector('[data-testid="reading-thinking-field"]'));
			await act(async () => (host.querySelector('[data-testid="teach-check-reveal"]') as HTMLElement).click());
			const choice = [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find(element => element.textContent?.includes("Table structure"))!;
			assert.ok(choice);
			await act(async () => choice.click());
			assert.equal(choice.getAttribute("aria-checked"), "true");
			const field = host.querySelector('[data-testid="thinking-field"] [data-file-path-input]');
			assert.ok(field);
			await renderBranch(root, { ...record, exploration: { ...record.exploration, status: "closed" } }, false);
			const enter = new window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(enter, "key", { value: "Enter" });
			await act(async () => window.dispatchEvent(enter));
			assert.equal(inputs.length, 0, "a returned child cannot consume the main lesson's keyboard input");
			await renderBranch(root, record);
			assert.equal(host.querySelector('[data-testid="thinking-field"] [data-file-path-input]'), field, "return did not remount the child answer field");
			assert.equal(choice.getAttribute("aria-checked"), "true");
			assert.equal(host.querySelector('[data-testid="teach-check-reveal"]'), null, "the opened check stays open");
			await act(async () => host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
			assert.equal(inputs.length, 1);
			assert.equal(inputs[0]?.chatId, "child");
			assert.equal(inputs[0]?.input.type, "answer");
			assert.equal(inputs[0]?.input.toolCallId, "child_check");
			assert.ok(host.querySelector('[role="radio"][aria-checked="true"]'), "offline submission restores the selected answer");
		});
	});

	it("returns from a nested exploration to its parent's exact scroll and cursor, or to the saved passage after remount", async () => {
		await withExplorationDOM(async (host, root) => {
			const parent = teachingBranch("explain", "predict");
			const leaf: ExplorationRecord = { ...chat, id: "leaf", messages: [
				{ id: "leaf_user", role: "user", content: [{ type: "text", text: "Why normalize?" }], timestamp: 1 },
				{ ...fauxAssistantMessage([fauxText("Normalization puts the curves on the same scale.")]), id: "leaf_teacher" },
			], exploration: { parentChatId: parent.id, rootChatId: "lesson", parentTitle: parent.title, sourceMessageId: "child_teacher", status: "active", topic: "Why normalize?" } };
			let savedLeaf: ExplorationRecord = { ...leaf, exploration: { ...leaf.exploration, status: "closed" } };
			const scroll = { scrollTop: 417 };
			const scroller = { current: { scrollRef: { current: scroll }, stopScroll() {} } as unknown as StickToBottomContext };
			const rootProps = { expanded: true, changing: false, canReopen: false, onInitialDelivered() {}, onToggle() {}, onClose() {}, onReopen() {}, scroller };
			const render = (key: string) => act(async () => root.render(<ServerEventsProvider connect={quietEvents}>
				<InlineExploration key={key} chat={parent} {...rootProps} />
			</ServerEventsProvider>));
			globalThis.fetch = (async (url: string, init?: RequestInit) => {
				if (url.endsWith("/draft")) return new Response(null, { status: 204 });
				if (url.startsWith("/api/jobs")) return Response.json({ jobs: [] });
				if (url === "/api/chats/child/explorations") return Response.json({ explorations: [savedLeaf] });
				if (url === "/api/chats/child/explorations/leaf") {
					const { action } = JSON.parse(String(init?.body));
					savedLeaf = { ...leaf, exploration: { ...leaf.exploration, status: action === "reopen" ? "active" : "closed" } };
					return Response.json({ chat: savedLeaf });
				}
				if (url === "/api/chats/leaf/explorations") return Response.json({ explorations: [] });
				return Response.json(url === "/api/chats/leaf" ? leaf : parent);
			}) as typeof fetch;
			const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === name)!;
			const waitForFrame = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); });

			await render("first");
			const answer = host.querySelector<HTMLElement>('[data-testid="answer-field"] [data-file-path-input]')!;
			answer.textContent = "My draft answer";
			let selected = -1;
			let focused = false;
			answer.focus = () => { focused = true; };
			Object.defineProperty(document, "activeElement", { configurable: true, get: () => answer });
			Object.defineProperty(document, "getSelection", { configurable: true, value: () => ({
				anchorNode: answer.firstChild, anchorOffset: 3, focusNode: answer.firstChild, focusOffset: 8,
				setBaseAndExtent: (_node: Node, start: number) => { selected = start; },
			}) });
			await act(async () => host.querySelector<HTMLElement>('#exploration-leaf button[aria-expanded="false"]')!.click());
			await act(async () => button("Continue exploring").click());
			assert.match(host.textContent ?? "", /Django › Why does this happen\? › Why normalize\?/);
			assert.equal(button("Return to lesson").disabled, true, "only the leaf can return");
			scroll.scrollTop = 990;
			await act(async () => button("Return to parent").click());
			await waitForFrame();
			assert.equal(scroll.scrollTop, 417);
			assert.equal(selected, 3);
			assert.equal(focused, true);
			assert.ok(host.querySelector('#exploration-leaf button[aria-expanded="true"]'), "return retains the archive layout it started from");
			assert.equal(host.querySelector('[data-testid="answer-field"] [data-file-path-input]'), answer);

			savedLeaf = leaf;
			await render("restarted");
			let anchored = false;
			const passage = host.querySelector<HTMLElement>("#message-child_teacher")!;
			passage.scrollIntoView = () => { anchored = true; };
			await act(async () => button("Return to parent").click());
			await waitForFrame();
			assert.equal(anchored, true);
		});
	});

	it("opens predictions immediately and uses the same reveal for free-response checks", async () => {
		await withExplorationDOM(async (host, root) => {
			const prediction = teachingBranch("explain", "predict");
			mockBranchRequests(prediction);
			await renderBranch(root, prediction);
			assert.equal(host.querySelector('[data-testid="teach-check-reveal"]'), null);
			assert.ok(host.querySelector('[data-testid="answer-field"]'));
		});
		await withExplorationDOM(async (host, root) => {
			const check = teachingBranch("explain");
			mockBranchRequests(check);
			await renderBranch(root, check);
			assert.ok(host.querySelector('[data-testid="teach-check-reveal"]'));
			await act(async () => (host.querySelector('[data-testid="teach-check-reveal"]') as HTMLElement).click());
			assert.ok(host.querySelector('[data-testid="answer-field"]'));
		});
	});

	it("dismisses a branch question through the child's silent route", async () => {
		await withExplorationDOM(async (host, root) => {
			const record = teachingBranch("ask_user_question");
			const calls: Array<{ url: string; body: unknown }> = [];
			globalThis.fetch = (async (url: string, init?: RequestInit) => {
				if (init?.method === "POST") { calls.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({ ok: true }); }
				if (url.endsWith("/explorations")) return Response.json({ explorations: [] });
				return Response.json(url.startsWith("/api/jobs") ? { jobs: [] } : record);
			}) as typeof fetch;
			await renderBranch(root, record);
			await act(async () => [...host.querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "Dismiss question")!.click());
			await act(async () => (document.querySelector('[data-testid="abort-turn-confirm"]') as HTMLElement).click());
			assert.equal(calls.length, 1);
			assert.equal(calls[0]?.url, "/api/chats/child/dismiss");
			assert.equal((calls[0]?.body as { input: { toolCallId: string } }).input.toolCallId, "child_check");
			assert.match(host.textContent ?? "", /dismissed|skipped/i);
		});
	});

	it("opens the child's plan through the page overlay callback, outside the inline transcript", async () => {
		await withExplorationDOM(async (host, root) => {
			const tree = { nodes: [{ id: "schema", title: "Schema structure" }], edges: [], version: 1 };
			const record: ExplorationRecord = { ...teachingBranch(), messages: [
				{ ...fauxAssistantMessage([fauxText("Here is this exploration's plan."), fauxToolCall("plan_init", tree, { id: "child_plan" })]), id: "child_plan_message" },
				{ id: "child_plan_result", role: "toolResult", toolCallId: "child_plan", toolName: "plan_init", details: { ok: true, tree },
					content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },
			] };
			record.messages.push(...planBlocksFor([], record.messages, tree, record.messages));
			mockBranchRequests(record);
			let received: LhViewMessage[] | undefined;
			await act(async () => root.render(<ServerEventsProvider connect={quietEvents}>
				<InlineExploration chat={record} expanded changing={false} canReopen onInitialDelivered={() => {}} onToggle={() => {}} onClose={() => {}} onReopen={() => {}} onOpenPlan={messages => { received = messages; }} />
			</ServerEventsProvider>));
			const block = host.querySelector('[data-testid="plan-block-full"]') as HTMLElement;
			assert.ok(block);
			await act(async () => block.click());
			assert.ok(received);
			assert.equal(latestTree(received)?.nodes[0]?.title, "Schema structure");
			assert.equal(host.querySelector('[data-testid="plan-popup"]'), null, "the inline scroller never owns the popup geometry");
		});
	});

	it("keeps artifact preferences scoped to the child record", async () => {
		await withExplorationDOM(async (host, root) => {
			const record: ExplorationRecord = { ...chat, exploration: { ...chat.exploration, status: "active" }, messages: [
				{ id: "child_demo", role: "custom", customType: "subagent-steer", content: "Delivery", display: true, timestamp: 1,
					details: { kind: "demo", result: { title: "Schema demo", html: "<p>Schema</p>" } } },
			] };
			const writes: string[] = [];
			globalThis.fetch = (async (url: string, init?: RequestInit) => {
				if (init?.method === "POST") writes.push(url);
				if (url.endsWith("/explorations")) return Response.json({ explorations: [] });
				return Response.json(url.startsWith("/api/jobs") ? { jobs: [] } : record);
			}) as typeof fetch;
			await renderBranch(root, record);
			await act(async () => (host.querySelector('[aria-label="Invert demo brightness"]') as HTMLElement).click());
			assert.deepEqual(writes, ["/api/chats/child/artifact-ui"]);
		});
	});

	it("shows a compaction pause and blocks return while the child history is compacting", async () => {
		await withExplorationDOM(async (host, root) => {
			const record = teachingBranch();
			globalThis.fetch = (async (url: string) => {
				if (url.endsWith("/explorations")) return Response.json({ explorations: [] });
				return Response.json(url.startsWith("/api/jobs") ? { jobs: [] } : { ...record, compacting: true });
			}) as typeof fetch;
			await renderBranch(root, record);
			assert.match(host.textContent ?? "", /Compacting this exploration/);
			const returnButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Return to lesson"));
			assert.equal(returnButton?.disabled, true);
			assert.match(host.textContent ?? "", /compacting session/);
		});
	});

	it("renders research and demo deliveries without exposing the worker's internal delivery text", () => {
		const record: ExplorationRecord = { ...chat, messages: [
			{ id: "research_result", role: "custom", customType: "subagent-steer", content: "PRIVATE_DELIVERY_GLUE", display: true, timestamp: 1,
				details: { kind: "research", result: { brief: "Schema findings.", sources: [] } } },
			{ id: "demo_result", role: "custom", customType: "subagent-steer", content: "PRIVATE_DEMO_NOTES", display: true, timestamp: 2,
				details: { kind: "demo", result: { title: "Schema demo", html: "<p>Interactive schema</p>" } } },
		] };
		const html = renderToStaticMarkup(<ServerEventsProvider connect={quietEvents}><InlineExploration chat={record} expanded changing={false} canReopen onInitialDelivered={() => {}} onToggle={() => {}} onClose={() => {}} onReopen={() => {}} /></ServerEventsProvider>);
		assert.match(html, /research-complete-badge/);
		assert.match(html, /Schema findings/);
		assert.match(html, /demo-card/);
		assert.match(html, /Schema demo/);
		assert.doesNotMatch(html, /PRIVATE_DELIVERY_GLUE|PRIVATE_DEMO_NOTES/);
	});
});
