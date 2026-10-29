import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createInlineExploration, changeInlineExploration, explorationErrorMessage, InlineExploration, useInlineExplorations, type ExplorationRecord } from "../components/inline-exploration.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { messageIdFromHash, propositionSessionHref } from "../src/core/session-navigation.ts";

const chat: ExplorationRecord = {
	id: "child", title: "Why does this happen?", createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", messages: [],
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
			const field = host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Type your answer…"]')!;
			assert.equal(field.defaultValue, "My unfinished explanation");
			await render(true);
			assert.equal(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Type your answer…"]'), field, "pausing did not remount the learner's field");
			await act(async () => enter());
			assert.equal(submitted.length, 0, "exploration keys cannot answer the lesson question");
			assert.equal(field.defaultValue, "My unfinished explanation");
			await render(false);
			assert.equal(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Type your answer…"]'), field, "returning preserved the exact field");
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
		location: { href: "http://localhost/chat/lesson", hash: "" }, IS_REACT_ACT_ENVIRONMENT: true })) {
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
