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

const source = "fn f() -> i32 {\n    let x: i32 = \"a\";\n    x\n}\nfn main() { f(); }\n";
const diagnostic = (resourceId: string, path: string, range: CodeDiagnostic["range"], message: string, severity: CodeDiagnostic["severity"] = "error"): CodeDiagnostic => ({ resourceId, path, range, severity, message, source: "rustc" });
const detail = (diagnostics: CodeDiagnostic[]): CodeRunDetail => ({
	version: 1, profile: { id: "rust2021-stdio", version: 1 },
	evidence: { snapshotId: "s", phases: [], diagnostics },
	assessment: { checkKind: "stdio", verdict: "not_run", cases: [] },
});
const result = (diagnostics: CodeDiagnostic[], status: CodeRunResult["status"] = "compilation_error"): CodeRunResult => ({
	id: "check-1", workspaceId: "w", language: "rust", source, revision: "rev", createdAt: "2026-10-29T12:00:00.000Z", compiler: "rustc 1.98.0 --edition=2021",
	status, tests: [], stdout: "", stderr: "error[E0308]: mismatched types", detail: detail(diagnostics),
});
const workspace = (lastRun: CodeRunResult): CodeWorkspaceView => ({ id: "w", language: "rust", filename: "solution.rs", source, revision: "rev", path: "/tmp/solution.rs", tests: [], lastRun });

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

test("Rust workbench registers Rust syntax and marks only learner-file diagnostics, by line when no column exists", async () => {
	const f = await mount(workspace(result([
		diagnostic("learner", "solution.rs", { line: 2, column: 18, endColumn: 21 }, "E0308: mismatched types (expected `i32`, found `&str`)"),
		diagnostic("learner", "solution.rs", { line: 3 }, "Panic: from the runtime"),
		diagnostic("support:util/mod.rs", "util/mod.rs", { line: 1 }, "E0425: from another file"),
		diagnostic("learner", "solution.rs", { line: 1 }, "note", "info"),
	])));
	try {
		assert.equal(f.view.state.facet(languageFacet)?.name, "rust");
		assert.equal(f.host.querySelector("[data-testid=code-editor]")!.getAttribute("data-language"), "rust");
		assert.match(f.host.textContent ?? "", /Rust 2021/);
		assert.deepEqual(f.marks(), [
			{ text: '"a"', message: "E0308: mismatched types (expected `i32`, found `&str`)", severity: "error" },
			{ text: "x", message: "Panic: from the runtime", severity: "error" },
		], "a column span marks exactly the token; a line-only diagnostic spans its line's code; support and info diagnostics are not underlined");
		await act(async () => f.view.dispatch({ changes: { from: 0, to: 1, insert: "F" } }));
		assert.deepEqual(f.marks(), [], "stale positions clear on edit");
	} finally { await f.dispose(); }
});

test("the C++ hint engine never runs against Rust", async () => {
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
		const syntax = view.state.facet(languageFacet)?.name;
		await act(async () => root.unmount());
		host.remove();
		return { count, syntax };
	};
	assert.ok((await marksFor("cpp")).count > 0);
	assert.deepEqual(await marksFor("rs"), { count: 0, syntax: "rust" }, "the alias selects Rust syntax and no C++ hints");
});

test("result rendering names the compiler for Rust and keeps the C++ labels", () => {
	const html = renderToStaticMarkup(<CodeCheckResults result={result([])} />);
	assert.match(html, /Compilation failed/);
	assert.match(html, /Compiler output/);
	assert.doesNotMatch(html, /Syntax check/);
	const unavailable = renderToStaticMarkup(<CodeCheckResults result={{ ...result([]), status: "unavailable" }} />);
	assert.match(unavailable, /Rust compiler unavailable/);
	const cpp = renderToStaticMarkup(<CodeCheckResults result={{ ...result([]), language: "cpp", detail: undefined, status: "compilation_error" }} />);
	assert.match(cpp, /Compilation failed/);
});
