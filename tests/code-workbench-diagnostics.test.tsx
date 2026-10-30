import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { CodeRunResult, CodeWorkspaceView } from "../src/core/code-workspace.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: () => 1,
	cancelAnimationFrame: () => {},
});
Object.assign(document, { getSelection: () => null, hasFocus: () => false });

const { CodeWorkbench } = await import("../components/code-workbench.tsx");
const { EditorView } = await import("@codemirror/view");
const { forEachDiagnostic } = await import("@codemirror/lint");

const source = "int main() {\n    unknown();\n}\n";
const result: CodeRunResult = {
	id: "check-1", workspaceId: "workspace-1", language: "cpp", source, revision: "revision-1",
	createdAt: "2026-10-29T12:00:00.000Z", compiler: "clang++", status: "compilation_error", tests: [],
	stdout: "support.cpp:1:1: warning: unrelated support file warning\n",
	stderr: "/tmp/exercise/answer.cpp:2:5: error: use of undeclared identifier 'unknown'\n",
};
const workspace: CodeWorkspaceView = {
	id: "workspace-1", language: "cpp", filename: "answer.cpp", source, revision: "revision-1",
	path: "/tmp/exercise/answer.cpp", tests: [], lastRun: result,
};

async function mount(next: CodeWorkspaceView) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json(next);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<CodeWorkbench chatId="chat-1" problemCallId="problem-1" />));
		const content = host.querySelector<HTMLElement>(".cm-content");
		assert.ok(content, "the loaded workspace renders its real CodeMirror editor");
		const view = EditorView.findFromDOM(content)!;
		assert.ok(view);
		return {
			host, view,
			messages() {
				const messages: string[] = [];
				forEachDiagnostic(view.state, diagnostic => messages.push(diagnostic.message));
				return messages;
			},
			async dispose() {
				await act(async () => root.unmount());
				host.remove();
				globalThis.fetch = originalFetch;
			},
		};
	} catch (error) {
		await act(async () => root.unmount());
		host.remove();
		globalThis.fetch = originalFetch;
		throw error;
	}
}

test("chat code workbench marks compiler errors for its filename and clears them after editing", async () => {
	const f = await mount(workspace);
	try {
		assert.deepEqual(f.messages(), ["use of undeclared identifier 'unknown'"]);
		await act(async () => f.view.dispatch({ changes: { from: 17, to: 24, insert: "known" } }));
		assert.deepEqual(f.messages(), [], "previous compiler locations must not mark the changed draft");
		assert.match(f.host.textContent ?? "", /Previous version/);
	} finally { await f.dispose(); }
});

test("chat code workbench does not mark diagnostics from a different source or revision", async () => {
	for (const lastRun of [
		{ ...result, source: "int main() {}" },
		{ ...result, revision: "previous-revision" },
	]) {
		const f = await mount({ ...workspace, lastRun });
		try {
			assert.deepEqual(f.messages(), []);
			assert.match(f.host.textContent ?? "", /Previous version/);
		} finally { await f.dispose(); }
	}
});
