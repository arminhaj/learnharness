import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { projectView, type LiveTurnState } from "../src/core/view.ts";
import { Reasoning, ReasoningContent, ReasoningStatus, ReasoningTrigger } from "../components/ai-elements/reasoning.tsx";

function assistant(id: string, content: AssistantMessage["content"]): AssistantMessage & { id: string } {
	return { id, role: "assistant", content, stopReason: "stop", timestamp: 1,
		api: "openai-responses", provider: "chatgpt", model: "fixture",
		usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
			cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
}

test("settled empty summaries stay hidden and opaque reasoning is never projected", () => {
	for (const thinking of ["", " \n\t"]) {
		const message = assistant("empty", [{ type: "thinking", thinking, thinkingSignature: "opaque-fixture" }]);
		assert.deepEqual(projectView([message]), []);
		const answered = assistant("answered", [...message.content, { type: "text", text: "Visible answer." }]);
		const parts = projectView([answered])[0]!.parts.filter(part => part.type !== "step-start");
		assert.deepEqual(parts.map(part => part.type), ["text"]);
		assert.equal(parts[0]!.text, "Visible answer.");
		assert.ok(!JSON.stringify(parts).includes("opaque-fixture"));
		assert.equal(message.content[0]?.type === "thinking" && message.content[0].thinkingSignature, "opaque-fixture", "presentation never modifies replay data");
	}
});

test("only the active native response owns the working row", () => {
	const messages = [
		assistant("earlier", [{ type: "thinking", thinking: "Available summary." }]),
		assistant("current", [{ type: "thinking", thinking: "", thinkingSignature: "opaque-fixture" }]),
	];
	const live: LiveTurnState = { inFlight: true, executions: new Map(), streamingIds: new Set(["earlier", "current"]), activeMessageId: "current" };
	const parts = projectView(messages, live)[0]!.parts.filter(part => part.type === "reasoning");
	assert.deepEqual(parts.map(({ text, state }) => ({ text, state })), [
		{ text: "Available summary.", state: "done" },
		{ text: "", state: "streaming" },
	]);
	const ended = projectView(messages, { ...live, activeMessageId: null })[0]!.parts.filter(part => part.type !== "step-start");
	assert.deepEqual(ended.map(({ type, text, state }) => ({ type, text, state })), [
		{ type: "reasoning", text: "Available summary.", state: "done" },
	]);
});

test("visible summaries retain text and stable IDs when empty siblings disappear", () => {
	const message = assistant("summary", [{ type: "thinking", thinking: "" }, { type: "thinking", thinking: "Available summary." }, { type: "text", text: "Answer." }]);
	const live: LiveTurnState = { inFlight: true, executions: new Map(), streamingIds: new Set(["summary"]), activeMessageId: "summary" };
	const parts = projectView([message], live)[0]!.parts.filter(part => part.type !== "step-start");
	assert.equal(parts[0]!.id, "summary-r1");
	assert.equal(parts[0]!.text, "Available summary.");
	assert.equal(parts[0]!.state, "streaming");
	assert.equal(parts[1]!.type, "text", "summary status does not depend on the last displayed part");
	assert.equal(projectView([message])[0]!.parts.find(part => part.type === "reasoning")!.state, "done");
});

test("empty active responses show a status without an empty disclosure", () => {
	const document = parseHTML(`<html><body>${renderToStaticMarkup(<ReasoningStatus />)}</body></html>`).document;
	assert.equal(document.querySelector('[role="status"]')?.getAttribute("aria-label"), "Working");
	assert.match(document.body.textContent ?? "", /Working…/);
	assert.equal(document.querySelector("button, [aria-expanded]"), null);
});

test("summary controls stay collapsed initially and preserve the learner's choice through completion", async () => {
	const dom = parseHTML("<html><body></body></html>");
	const globals = { window: dom.window, document: dom.document, Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () => ({ display: "block", animationName: "none" }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle) };
	const previous = Object.getOwnPropertyDescriptors(globalThis);
	Object.assign(globalThis, globals);
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const render = (streaming: boolean, summary = "Available summary.") =>
		<Reasoning isStreaming={streaming}><ReasoningTrigger /><ReasoningContent>{summary}</ReasoningContent></Reasoning>;
	try {
		await act(async () => root.render(render(true)));
		const trigger = () => host.querySelector("button")!;
		assert.equal(trigger().getAttribute("aria-expanded"), "false");
		assert.match(trigger().textContent ?? "", /Working…/);
		await act(async () => trigger().click());
		assert.equal(trigger().getAttribute("aria-expanded"), "true");
		await act(async () => root.render(render(false)));
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
		assert.equal(trigger().getAttribute("aria-expanded"), "true", "completion must not close a summary the learner opened");
		assert.match(trigger().textContent ?? "", /Reasoning summary/);
		assert.equal(host.querySelector('[role="status"]'), null, "completed summaries have no working indicator");
		assert.match(host.textContent ?? "", /Available summary\./);
		await act(async () => trigger().click());
		await act(async () => root.render(render(true, "Updated available summary.")));
		assert.equal(trigger().getAttribute("aria-expanded"), "false", "updates must not reopen a manually closed summary");
	} finally {
		await act(async () => root.unmount()); host.remove();
		for (const key of Object.keys(globals)) {
			if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
