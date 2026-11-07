import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { CodeDiagnostic, CodeRunDetail } from "../src/core/code-activity.ts";
import { API_DEMO_CODE_CONTEXT } from "../src/core/api-code-completion.ts";
import { findExerciseCodeDiagnostics } from "../src/core/code-diagnostics.ts";
import type { CodeRunResult, CodeWorkspaceView } from "../src/core/code-workspace.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
});
Object.assign(document, { getSelection: () => null, hasFocus: () => false });

const { CodeWorkbench, CodeCheckResults } = await import("../components/code-workbench.tsx");
const { CodeEditor } = await import("../components/code-editor.tsx");
const { EditorView } = await import("@codemirror/view");
const { forEachDiagnostic } = await import("@codemirror/lint");
const { language: languageFacet } = await import("@codemirror/language");
const { renderToStaticMarkup } = await import("react-dom/server");

const source = "def f():\n    return 1 / 0\n\nx = (1 +\n";
const diagnostic = (resourceId: string, path: string, range: CodeDiagnostic["range"], message: string, severity: CodeDiagnostic["severity"] = "error"): CodeDiagnostic => ({ resourceId, path, range, severity, message, source: "python" });
const detail = (diagnostics: CodeDiagnostic[]): CodeRunDetail => ({
	version: 1, profile: { id: "python3-stdio", version: 1 },
	evidence: { snapshotId: "s", phases: [], diagnostics },
	assessment: { checkKind: "stdio", verdict: "not_run", cases: [] },
});
const result = (diagnostics: CodeDiagnostic[], status: CodeRunResult["status"] = "runtime_error"): CodeRunResult => ({
	id: "check-1", workspaceId: "w", language: "python", source, revision: "rev", createdAt: "2026-10-29T12:00:00.000Z", compiler: "python 3.12.7",
	status, tests: [], stdout: "", stderr: "solution.py:2: ZeroDivisionError", detail: detail(diagnostics),
});
const workspace = (lastRun: CodeRunResult): CodeWorkspaceView => ({ id: "w", language: "python", filename: "solution.py", source, revision: "rev", path: "/tmp/solution.py", tests: [], lastRun });

async function mount(next: CodeWorkspaceView) {
	const original = globalThis.fetch;
	globalThis.fetch = async () => Response.json(next);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(<CodeWorkbench chatId="c" problemCallId="p" />));
	const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-content")!)!;
	return {
		host, view,
		marks() {
			const marks: { text: string; message: string; severity: string }[] = [];
			forEachDiagnostic(view.state, (item, from, to) => marks.push({ text: view.state.sliceDoc(from, to), message: item.message, severity: item.severity }));
			return marks;
		},
		async dispose() { await act(async () => root.unmount()); host.remove(); globalThis.fetch = original; },
	};
}

test("Python workbench registers Python syntax and marks only learner-file diagnostics, by line when no column exists", async () => {
	const f = await mount(workspace(result([
		diagnostic("learner", "solution.py", { line: 2 }, "ZeroDivisionError: division by zero"),
		diagnostic("learner", "solution.py", { line: 4, column: 5, endLine: 4, endColumn: 6 }, "SyntaxError: '(' was never closed"),
		diagnostic("support:helper.py", "helper.py", { line: 1 }, "ValueError: from another file"),
		diagnostic("learner", "solution.py", { line: 1 }, "Called from here.", "info"),
	])));
	try {
		assert.equal(f.view.state.facet(languageFacet)?.name, "python");
		assert.equal(f.host.querySelector("[data-testid=code-editor]")!.getAttribute("data-language"), "python");
		assert.match(f.host.textContent ?? "", /Python 3\.11\+/);
		assert.deepEqual(f.marks(), [
			{ text: "return 1 / 0", message: "ZeroDivisionError: division by zero", severity: "error" },
			{ text: "(", message: "SyntaxError: '(' was never closed", severity: "error" },
		], "a line-only diagnostic spans the code on its line, never a guessed token; support and info frames are not underlined");
		await act(async () => f.view.dispatch({ changes: { from: 0, to: 1, insert: "D" } }));
		assert.deepEqual(f.marks(), [], "stale positions clear on edit");
	} finally { await f.dispose(); }
});

test("the C++ hint engine never runs against Python", async () => {
	const cppSource = "void f() { return }";
	assert.ok(findExerciseCodeDiagnostics(cppSource, API_DEMO_CODE_CONTEXT).length > 0, "control: the engine does flag this C++");
	const marksFor = async (language: string) => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => root.render(<CodeEditor value={cppSource} onChange={() => {}} language={language} completionContext={API_DEMO_CODE_CONTEXT} />));
		const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-content")!)!;
		let count = 0;
		forEachDiagnostic(view.state, () => count++);
		await act(async () => root.unmount());
		host.remove();
		return count;
	};
	assert.ok(await marksFor("cpp") > 0);
	assert.equal(await marksFor("python"), 0);
});

test("result rendering names the syntax check, not compilation, for Python and keeps C++ labels", () => {
	const html = renderToStaticMarkup(<CodeCheckResults result={result([], "preparation_error")} />);
	assert.match(html, /Syntax check failed/);
	assert.match(html, /Syntax check output/);
	assert.doesNotMatch(html, /Compil/);
	const unavailable = renderToStaticMarkup(<CodeCheckResults result={{ ...result([]), status: "unavailable" }} />);
	assert.match(unavailable, /Python unavailable/);
	const cpp = renderToStaticMarkup(<CodeCheckResults result={{ ...result([]), language: "cpp", detail: undefined, status: "compilation_error" }} />);
	assert.match(cpp, /Compilation failed/);
	assert.match(cpp, /Compiler output/);
});

test("a preparation failure is explained immediately, even when only a support module is at fault", () => {
	const support = { ...result([diagnostic("support:helper.py", "helper.py", { line: 1, column: 5 }, "SyntaxError: invalid syntax")], "preparation_error"), stdout: "", stderr: "helper.py:1:5: SyntaxError: invalid syntax" };
	const html = renderToStaticMarkup(<CodeCheckResults result={support} />);
	assert.match(html, /<details open=""[^>]*>[\s\S]*Syntax check output/, "the output section is open, not collapsed");
	assert.match(html, /helper\.py:1:5: SyntaxError: invalid syntax/);
	// Control: a runtime error's compiler-style output stays collapsed.
	const runtime = renderToStaticMarkup(<CodeCheckResults result={{ ...support, status: "runtime_error" }} />);
	assert.doesNotMatch(runtime, /<details open=""[^>]*>[\s\S]*Syntax check output/);
});
