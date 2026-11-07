import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { CodeRunResult, CodeWorkspaceView, QuestionAnswerData } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
});
Object.assign(document, { getSelection: () => null, hasFocus: () => false });
const { QuestionDock } = await import("../components/question-dock.tsx");
const { AnsweredCard } = await import("../components/answered-card.tsx");
const { EditorView } = await import("@codemirror/view");

const source = "#include <iostream>\nint main() { std::cout << 0; }\n";
const exercise = { language: "cpp" as const, starterCode: source, tests: [{ name: "Example", stdin: "", expectedStdout: "5\n" }] };
const result: CodeRunResult = {
	id: "check-teaching", workspaceId: "workspace-teaching", source, revision: "initial", language: "cpp",
	status: "tests_failed", compiler: "clang++", stdout: "", stderr: "", createdAt: "2026-10-30T12:00:00Z",
	tests: [{ ...exercise.tests[0]!, stdout: "0", stderr: "", status: "failed", exitCode: 0 }],
};

async function mount(onSubmit: (answer: QuestionAnswerData, codeRunId?: string) => void | Promise<void>) {
	const originalFetch = globalThis.fetch;
	const requests: Record<string, unknown>[] = [];
	let workspace: CodeWorkspaceView = {
		id: result.workspaceId, language: "cpp", filename: "solution.cpp", source,
		revision: "initial", path: "/tmp/teaching/solution.cpp", tests: exercise.tests,
	};
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body)); requests.push(body);
		if (body.action === "save") workspace = { ...workspace, source: body.source, revision: "edited" };
		if (body.action === "check") workspace = { ...workspace, lastRun: { ...result, source: workspace.source, revision: workspace.revision } };
		return Response.json(workspace);
	};
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	async function render(expanded = true, paused = false, compactionRunning = false) {
		await act(async () => root.render(<QuestionDock chatId="teaching-chat" toolCallId="coding-ask" toolName="ask_user_question"
			input={{ question: "Find the longest valid window.", codeExercise: exercise }}
			expanded={expanded} paused={paused} compactionRunning={compactionRunning}
			onExpand={() => {}} onSubmit={onSubmit} dictationClaim={false} />));
	}
	await render();
	return { host, requests, render, async dispose() { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; } };
}

function checkButton(host: HTMLElement) {
	const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Check & submit");
	assert.ok(button); return button;
}

test("Teaching mounts the native workspace and preserves its unsaved editor across collapse", async () => {
	const f = await mount(() => {});
	try {
		assert.ok(f.host.querySelector('[data-testid="teaching-code-workspace"]'));
		assert.match(f.host.querySelector('[data-testid="question-dock"]')?.className ?? "", /lg:grid-cols/);
		assert.match(f.host.textContent ?? "", /Coding exercise/);
		assert.doesNotMatch(f.host.textContent ?? "", /Draw structure/);
		const content = f.host.querySelector<HTMLElement>(".cm-content")!;
		const view = EditorView.findFromDOM(content)!;
		await act(async () => view.dispatch({ changes: { from: 0, insert: "// keep this draft\n" } }));
		await f.render(false);
		assert.match(f.host.textContent ?? "", /Return to code/);
		assert.equal(f.host.querySelector(".cm-content"), content);
		await f.render(true);
		assert.equal(f.host.querySelector(".cm-content"), content);
		assert.match(view.state.doc.toString(), /keep this draft/);
		assert.equal(f.requests.filter(r => r.action === "load").length, 1);
		assert.equal(f.requests[0]?.chatId, "teaching-chat");
		assert.equal(f.requests[0]?.problemCallId, "coding-ask");
		await f.render(true, true);
		assert.equal(checkButton(f.host).disabled, true);
		await f.render(true, false, true);
		assert.equal(checkButton(f.host).disabled, true);
	} finally { await f.dispose(); }
});

test("Teaching check submission carries reasoning and rejects failed acknowledgement without a success notice", async () => {
	const submissions: { answer: QuestionAnswerData; runId?: string }[] = [];
	let reject = true;
	const f = await mount(async (answer, runId) => {
		submissions.push({ answer, runId });
		if (reject) throw new Error("Saved code changed; check again.");
	});
	try {
		const content = f.host.querySelector<HTMLElement>(".cm-content")!;
		const view = EditorView.findFromDOM(content)!;
		await act(async () => {
			view.dispatch({ changes: { from: 0, insert: "// my implementation\n" } });
			const thinking = f.host.querySelector<HTMLElement>('[data-testid="answer-field"] [data-file-path-input]')!;
			thinking.textContent = "The left boundary only moves forward.";
			thinking.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await act(async () => checkButton(f.host).click());
		assert.equal(submissions[0]?.runId, "check-teaching");
		assert.equal(submissions[0]?.answer.kind, "ask");
		assert.equal(submissions[0]?.answer.thinking, "The left boundary only moves forward.");
		assert.equal(submissions[0]?.answer.codeResult, undefined, "only the server attaches compiler evidence");
		assert.match(f.host.textContent ?? "", /Saved code changed; check again/);
		assert.doesNotMatch(f.host.textContent ?? "", /Code and check results submitted/);
		assert.match(view.state.doc.toString(), /my implementation/);
		assert.equal(f.host.querySelector('[data-file-path-input]')?.textContent, "The left boundary only moves forward.");
		reject = false;
		await act(async () => checkButton(f.host).click());
		assert.match(f.host.textContent ?? "", /Code and check results submitted/);
	} finally { await f.dispose(); }
});

test("Teaching transcript displays saved compiler evidence without adding quiz grading", () => {
	const answer: QuestionAnswerData = {
		kind: "ask", tool: "ask_user_question", questionText: "Implement a window.",
		options: [], answers: [], dontKnow: false, answeredAt: "2026-10-30T12:00:00Z",
		text: "```cpp\n" + source + "```", thinking: "Maintain a valid interval.", codeResult: result,
	};
	const html = renderToStaticMarkup(<AnsweredCard answer={answer} input={{ question: answer.questionText, codeExercise: exercise }} />);
	assert.match(html, /code-check-results/);
	assert.match(html, /Compiled · some tests failed/);
	assert.match(html, /0\/1 tests/);
	assert.doesNotMatch(html, /incorrect|answered-confidence/);
});
