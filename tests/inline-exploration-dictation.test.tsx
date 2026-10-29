import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { DictationBar, finishDictation, METER_TICK_MS, useDictation, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { InlineExploration, type ExplorationRecord } from "../components/inline-exploration.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { readPathInput } from "../components/path-input-dom.ts";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	sent: unknown[] = [];
	constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.all.push(this); }
	send(data: unknown) { this.sent.push(data); }
	close() { this.readyState = 3; }
	open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
	end() { this.close(); this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
	final(text: string) {
		this.dispatchEvent(Object.assign(new Event("message"), {
			data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } }),
		}));
	}
}
class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static all: Worklet[] = [];
	port: { onmessage?: (event: { data: { type: string; rms?: number; buffer?: ArrayBuffer } }) => void } = {};
	constructor() { Worklet.all.push(this); }
	connect() {}
	disconnect() {}
	emit(data: { type: string; rms?: number; buffer?: ArrayBuffer }) { this.port.onmessage?.({ data }); }
}
class MeterResizeObserver {
	constructor(readonly callback: () => void) {}
	observe(target: HTMLElement) {
		Object.defineProperty(target, "clientWidth", { configurable: true, value: 192 });
		this.callback();
	}
	disconnect() {}
}

const quietEvents = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });
const child: ExplorationRecord = {
	id: "dictation_child", title: "Energy derivation", createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z",
	exploration: { parentChatId: "lesson", sourceMessageId: "m_source", parentTitle: "Physics", topic: "Energy derivation", status: "active" },
	messages: [
		{ id: "child_user", role: "user", content: [{ type: "text", text: "Help me derive energy." }], timestamp: 1 },
		{ ...fauxAssistantMessage([
			fauxText("Hold the coordinate and velocity fixed when differentiating with respect to time."),
			fauxToolCall("explain", { question: "What is explicit time dependence?", type: "check", nodeId: "energy", correctAnswer: "Dependence with the coordinate and velocity held fixed." }, { id: "child_check" }),
		], { stopReason: "toolUse" }), id: "child_teacher" },
	],
};

async function fixture(tool: "explain" | "quiz" = "explain") {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const branchRecord = tool === "explain" ? child : { ...child, messages: [
		child.messages[0]!,
		{ ...fauxAssistantMessage([
			fauxText("Hold the coordinate and velocity fixed when differentiating with respect to time."),
			fauxToolCall("quiz", { question: "What is held fixed?", type: "check", nodeId: "energy",
				options: [{ label: "Coordinate and velocity" }, { label: "Time" }], correctAnswer: "Coordinate and velocity", explanation: "Time is the explicit argument." }, { id: "child_check" }),
		], { stopReason: "toolUse" }), id: "child_teacher" },
	] };
	const prior = new Map<string, PropertyDescriptor | undefined>();
	const requests: Array<{ chatId: string; input: { type: string; toolCallId?: string; output?: { text?: string; answer?: string; readingThinking?: string } } }> = [];
	const parentAnswers: unknown[] = [];
	const fallback: string[] = [];
	Socket.all = [];
	Worklet.all = [];
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
		location: { href: "http://localhost/chat/lesson", hash: "" }, IS_REACT_ACT_ENVIRONMENT: true,
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet, ResizeObserver: MeterResizeObserver,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") return Response.json({ token: "test-token" });
			if (url === "/api/settings") return Response.json({ settings: { version: 1, dictation: { language: "en" } } });
			if (url.startsWith("/api/jobs")) return Response.json({ jobs: [] });
			if (url === "/api/chat") {
				requests.push(JSON.parse(String(init?.body)));
				return Response.json({ error: "Offline for this test." }, { status: 503 });
			}
			assert.equal(url, `/api/chats/${child.id}`);
			return Response.json(branchRecord);
		},
	})) {
		prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	let dictation!: Dictation;
	let setActive!: (value: boolean) => void;
	function Harness() {
		const [active, updateActive] = useState(true);
		setActive = updateActive;
		dictation = useDictation({ append: text => fallback.push(text) });
		const record: ExplorationRecord = { ...branchRecord, exploration: { ...branchRecord.exploration, status: active ? "active" : "closed" } };
		return <ServerEventsProvider connect={quietEvents}>
			<InlineExploration chat={record} expanded={active} changing={false} canReopen={!active}
				dictationSlot={<DictationBar dictation={dictation} />}
				onInitialDelivered={() => {}} onToggle={() => {}} onReopen={() => updateActive(true)}
				onClose={() => { void finishDictation().then(() => updateActive(false)); }} />
			<div data-parent-dock="" inert={active}>
				<QuestionDock toolName="explain" toolCallId="parent_check" input={{ question: "Main lesson question", correctAnswer: "Main lesson answer" }}
					expanded paused={active} dictationClaim={!active} onExpand={() => {}} onSubmit={answer => parentAnswers.push(answer)}
					initialDraft={{ text: "Lesson draft", thinking: "", other: "", confidenceIndex: 2, selection: { selected: new Set(), dontKnow: false, otherSelected: false } }} />
			</div>
		</ServerEventsProvider>;
	}
	const host = document.getElementById("root")!;
	const root = createRoot(host);
	await act(async () => { root.render(<Harness />); });
	await act(async () => { notifySettingsSaved("dictation"); });
	const branch = () => host.querySelector<HTMLElement>(`[data-exploration-id="${child.id}"]`)!;
	const answer = () => branch().querySelector<HTMLElement>('[data-testid="answer-field"] [data-file-path-input]')!;
	const parent = () => host.querySelector<HTMLElement>('[data-parent-dock] [data-file-path-input]')!;
	return {
		host, branch, answer, parent, requests, parentAnswers, fallback,
		get dictation() { return dictation; },
		get submitButton() { return [...branch().querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Submit answer")!; },
		reveal: () => act(async () => { (branch().querySelector('[data-testid="teach-check-reveal"]') as HTMLElement).click(); }),
		setActive: (active: boolean) => act(async () => { setActive(active); }),
		start: async (text: string) => {
			await act(async () => { dictation.toggle(); });
			const socket = Socket.all.at(-1)!;
			assert.ok(socket);
			await act(async () => { socket.open(); socket.final(text); });
			return socket;
		},
		stop: async (socket: Socket) => {
			await act(async () => { dictation.stop(); });
			await act(async () => { socket.end(); });
		},
		enter: () => act(async () => {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "Enter" });
			window.dispatchEvent(event);
		}),
		dispose: async () => {
			await act(async () => { root.unmount(); });
			for (const [key, descriptor] of prior) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		},
	};
}

test("the exploration's Dictate button drives capture, a responsive meter, and the child transcript", async (context) => {
	context.mock.timers.enable({ apis: ["setInterval"] });
	const f = await fixture();
	try {
		await f.reveal();
		const start = f.branch().querySelector<HTMLButtonElement>('[aria-label="Start dictation"]')!;
		assert.ok(start, "the inline footer renders the real DictationBar control");
		await act(async () => { start.click(); });
		const socket = Socket.all.at(-1)!;
		const worklet = Worklet.all.at(-1)!;
		assert.ok(socket, "clicking the inline button starts the shared audio/socket path");
		assert.ok(worklet);
		await act(async () => { socket.open(); });
		assert.equal(f.dictation.phase, "recording");
		const meter = f.branch().querySelector<HTMLElement>('[data-testid="dictation-meter"]')!;
		assert.equal(meter.children.length, 48, "the ResizeObserver fits the real meter bars to the footer");
		assert.ok([...meter.children].every(bar => (bar as HTMLElement).style.height === "2px"));
		await act(async () => {
			worklet.emit({ type: "level", rms: 0.05 });
			context.mock.timers.tick(METER_TICK_MS);
		});
		assert.ok(parseInt((meter.lastElementChild as HTMLElement).style.height) > 2, "a worklet level sample visibly raises the meter");
		const pcm = new Int16Array([0, 1200, -1200, 3000]).buffer;
		worklet.emit({ type: "audio", buffer: pcm });
		assert.equal(socket.sent.at(-1), pcm, "captured PCM reaches the transcription socket unchanged");
		await act(async () => { socket.final("The coordinate and velocity are held fixed."); });
		assert.equal(readPathInput(f.answer()), "", "the transcript remains deferred until Stop");
		await act(async () => { f.branch().querySelector<HTMLButtonElement>('[aria-label="Stop dictation"]')!.click(); });
		assert.equal(f.dictation.phase, "stopping");
		assert.equal(socket.sent.at(-1), JSON.stringify({ type: "CloseStream" }));
		await act(async () => { socket.end(); });
		assert.equal(readPathInput(f.answer()), "The coordinate and velocity are held fixed.");
		assert.equal(readPathInput(f.parent()), "Lesson draft");
		assert.ok(f.branch().querySelector('[aria-label="Start dictation"]'));
		assert.deepEqual(f.fallback, []);
	} finally { await f.dispose(); }
});

test("dictation follows reading, child answer, returned lesson, and reopened child without crossing drafts", async () => {
	const f = await fixture();
	try {
		const reading = f.branch().querySelector<HTMLElement>('[data-testid="reading-thinking-field"] [data-file-path-input]')!;
		const first = await f.start("Reading thought.");
		assert.equal(readPathInput(reading), "", "dictation intentionally stays deferred during recording");
		await f.stop(first);
		assert.equal(readPathInput(reading), "Reading thought.");
		assert.equal(readPathInput(f.answer()), "");
		assert.equal(readPathInput(f.parent()), "Lesson draft");
		const duringReveal = await f.start("Another reading thought.");
		await f.reveal();
		assert.equal(f.dictation.phase, "stopping", "opening the check finishes reading dictation first");
		assert.ok(f.branch().querySelector('[data-testid="teach-check-reveal"]'));
		await act(async () => { duringReveal.end(); });
		assert.equal(readPathInput(reading), "Reading thought. Another reading thought.");
		const answer = f.answer();
		await f.stop(await f.start("Child answer."));
		assert.equal(readPathInput(answer), "Child answer.");
		assert.equal(readPathInput(reading), "Reading thought. Another reading thought.");
		assert.equal(readPathInput(f.parent()), "Lesson draft");
		const duringReturn = await f.start("Return tail.");
		await act(async () => {
			[...f.branch().querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Return to lesson"))!.click();
		});
		assert.equal(f.dictation.phase, "stopping", "Return finishes the child's recording before releasing its target");
		await act(async () => { duringReturn.end(); });
		assert.equal(readPathInput(answer), "Child answer. Return tail.");
		await f.stop(await f.start("Parent answer."));
		assert.equal(readPathInput(f.parent()), "Lesson draft Parent answer.");
		assert.equal(readPathInput(answer), "Child answer. Return tail.");
		await f.setActive(true);
		assert.equal(f.answer(), answer, "return/reopen preserves the existing answer field");
		await f.stop(await f.start("More child reasoning."));
		assert.equal(readPathInput(answer), "Child answer. Return tail. More child reasoning.");
		assert.equal(readPathInput(f.parent()), "Lesson draft Parent answer.");
		assert.deepEqual(f.fallback, []);
		assert.deepEqual(f.parentAnswers, []);
		assert.deepEqual(f.requests, []);
	} finally { await f.dispose(); }
});

for (const trigger of ["Enter", "button"] as const) {
	test(`a blank exploration answer can finish and submit dictated speech with ${trigger}`, async () => {
		const f = await fixture();
		try {
			await f.reveal();
			const socket = await f.start("The coordinate and velocity are held fixed.");
			assert.equal(readPathInput(f.answer()), "");
			if (trigger === "Enter") await f.enter();
			else {
				assert.equal(f.submitButton.disabled, false, "recording speech makes a blank free-response answer submittable");
				// linkedom does not implement the browser's button→form submit default action.
				await act(async () => { f.submitButton.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
			}
			assert.equal(f.dictation.phase, "stopping", "submission finishes the active recording first");
			assert.equal(f.requests.length, 0, "wait for the final transcript before submitting");
			await f.enter();
			await f.enter();
			await act(async () => { socket.final("Time is the explicit argument."); socket.end(); });
			assert.equal(f.requests.length, 1, "repeated Enter while stopping cannot duplicate the answer");
			assert.equal(f.requests[0]?.chatId, child.id);
			assert.equal(f.requests[0]?.input.type, "answer");
			assert.equal(f.requests[0]?.input.toolCallId, "child_check");
			assert.match(JSON.stringify(f.requests[0]?.input), /The coordinate and velocity are held fixed\. Time is the explicit argument\./);
			assert.equal(readPathInput(f.parent()), "Lesson draft");
			assert.deepEqual(f.parentAnswers, []);
			assert.deepEqual(f.fallback, []);
		} finally { await f.dispose(); }
	});
}

test("finishing a silent exploration recording never submits an empty answer", async () => {
	const f = await fixture();
	try {
		await f.reveal();
		const socket = await f.start("");
		await f.enter();
		assert.equal(f.dictation.phase, "stopping");
		await act(async () => { socket.end(); });
		assert.equal(readPathInput(f.answer()), "");
		assert.equal(f.requests.length, 0);
		assert.equal(f.parentAnswers.length, 0);
		assert.equal(f.submitButton.disabled, true);
	} finally { await f.dispose(); }
});

test("dictating exploration quiz reasoning still requires an answer selection", async () => {
	const f = await fixture("quiz");
	try {
		await f.reveal();
		const socket = await f.start("Time is the explicit argument.");
		assert.equal(f.submitButton.disabled, true);
		await f.enter();
		assert.equal(f.dictation.phase, "recording", "reasoning alone is not a quiz choice");
		assert.equal(f.requests.length, 0);
		await f.stop(socket);
		const thinking = f.branch().querySelector<HTMLElement>('[data-testid="thinking-field"] [data-file-path-input]')!;
		assert.equal(readPathInput(thinking), "Time is the explicit argument.");
		await act(async () => {
			[...f.branch().querySelectorAll<HTMLElement>('[role="radio"]')].find(option => option.textContent?.includes("Coordinate and velocity"))!.click();
		});
		const more = await f.start("Those two are held fixed.");
		await f.enter();
		assert.equal(f.dictation.phase, "stopping");
		await act(async () => { more.end(); });
		assert.equal(f.requests.length, 1);
		assert.equal(f.requests[0]?.chatId, child.id);
		assert.match(JSON.stringify(f.requests[0]?.input), /Time is the explicit argument\. Those two are held fixed\./);
		assert.deepEqual(f.parentAnswers, []);
	} finally { await f.dispose(); }
});
