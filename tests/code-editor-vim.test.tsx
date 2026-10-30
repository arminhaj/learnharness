import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
	// Linkedom has no layout or native selection. These tests exercise the real
	// editor's state commands and event routing; browser checks cover geometry,
	// focus, native text insertion, and the visible block cursor.
	requestAnimationFrame: () => 1,
	cancelAnimationFrame: () => {},
});
Object.assign(document, { getSelection: () => null, hasFocus: () => false });

const { CodeEditor } = await import("../components/code-editor.tsx");
const { EditorView, activateHover } = await import("@codemirror/view");
const { getCM } = await import("@replit/codemirror-vim");
const { completionStatus, currentCompletions } = await import("@codemirror/autocomplete");
const { forEachDiagnostic } = await import("@codemirror/lint");
const { API_DEMO_CODE_CONTEXT } = await import("../src/core/api-code-completion.ts");
type Assistance = Pick<import("../components/code-editor.tsx").CodeEditorProps, "completionContext" | "diagnostics">;

async function fixture(initialValue = "alpha beta\ngamma", initiallyDisabled = false, assistance: Assistance = {}) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const changes: string[] = [];
	let submissions = 0;
	let ancestorKeys = 0;
	let documentKeys = 0;
	const onDocumentKey = () => { documentKeys++; };
	document.addEventListener("keydown", onDocumentKey);
	const render = async (disabled: boolean, nextAssistance = assistance) => {
		await act(async () => root.render(
			<div onKeyDown={() => { ancestorKeys++; }}>
				<CodeEditor value={initialValue} onChange={value => changes.push(value)} onSubmit={() => { submissions++; }} disabled={disabled} {...nextAssistance} />
				<button type="button" data-testid="outside-editor">Outside editor</button>
			</div>,
		));
	};
	await render(initiallyDisabled);
	const content = host.querySelector<HTMLElement>(".cm-content")!;
	const view = EditorView.findFromDOM(content)!;
	assert.ok(view, "the actual CodeMirror editor mounted");
	const cm = getCM(view)!;
	assert.ok(cm, "the actual Vim extension is installed");
	async function press(key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}, target: HTMLElement = content) {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key, code: key === "[" ? "BracketLeft" : key, keyCode: key === "Escape" ? 27 : key === "Enter" ? 13 : key === "Tab" ? 9 : key.toUpperCase().charCodeAt(0), ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers });
		await act(async () => { target.dispatchEvent(event); });
		return event;
	}
	return {
		host, view, cm, changes, press, render,
		counts: () => ({ submissions, ancestorKeys, documentKeys }),
		async dispose() {
			document.removeEventListener("keydown", onDocumentKey);
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

test("Vim normal-mode motion, deletion, and undo operate on the actual editor", async () => {
	const f = await fixture();
	try {
		assert.equal(f.cm.state.vim?.insertMode, false);
		await f.press("l");
		assert.equal(f.view.state.selection.main.head, 1);
		await f.press("x");
		assert.equal(f.view.state.doc.toString(), "apha beta\ngamma");
		assert.equal(f.changes.at(-1), "apha beta\ngamma");
		await f.press("u");
		assert.equal(f.view.state.doc.toString(), "alpha beta\ngamma");
		assert.equal(f.changes.at(-1), "alpha beta\ngamma");
		assert.equal(f.counts().submissions, 0);
	} finally { await f.dispose(); }
});

test("Escape and Ctrl+[ exit insert mode without reaching application shortcuts", async () => {
	const f = await fixture();
	try {
		await f.press("i");
		assert.equal(f.cm.state.vim?.insertMode, true);
		await f.press("Escape");
		assert.equal(f.cm.state.vim?.insertMode, false);
		await f.press("Escape"); // Already normal: this still belongs to the editor.
		await f.press("i");
		await f.press("[", { ctrlKey: true });
		assert.equal(f.cm.state.vim?.insertMode, false);
		// An unclaimed Ctrl+G is also isolated, so the app cannot navigate away.
		await f.press("g", { ctrlKey: true });
		assert.deepEqual(f.counts(), { submissions: 0, ancestorKeys: 0, documentKeys: 0 });
		await f.press("Escape", {}, f.host.querySelector<HTMLElement>('[data-testid="outside-editor"]')!);
		assert.equal(f.counts().ancestorKeys, 1, "the ancestor listener is live outside the editor");
		assert.equal(f.counts().documentKeys, 1, "the document listener is live outside the editor");
	} finally { await f.dispose(); }
});

test("Command/Ctrl+Enter submit exactly once from both Vim modes without editing the source", async () => {
	const f = await fixture();
	try {
		const source = f.view.state.doc.toString();
		let expected = 0;
		for (const insert of [false, true]) {
			if (insert) await f.press("i");
			for (const modifier of ["metaKey", "ctrlKey"] as const) {
				const event = await f.press("Enter", { [modifier]: true });
				assert.equal(event.defaultPrevented, true);
				assert.equal(f.counts().submissions, ++expected);
				assert.equal(f.view.state.doc.toString(), source);
				assert.equal(f.cm.state.vim?.insertMode, insert, "submission does not change Vim mode");
			}
		}
		assert.equal(f.counts().ancestorKeys, 0);
		assert.equal(f.counts().documentKeys, 0);
	} finally { await f.dispose(); }
});

test("a disabled editor rejects Vim edits and submission, then responds again when enabled", async () => {
	const f = await fixture("alpha beta", true);
	try {
		await f.press("x");
		await f.press("d");
		await f.press("d");
		await f.press("Enter", { ctrlKey: true });
		await f.press("Enter", { metaKey: true });
		assert.equal(f.view.state.doc.toString(), "alpha beta");
		assert.deepEqual(f.changes, []);
		assert.equal(f.counts().submissions, 0);
		await f.render(false);
		await f.press("x");
		assert.equal(f.view.state.doc.toString(), "lpha beta");
		await f.press("Enter", { ctrlKey: true });
		assert.equal(f.counts().submissions, 1);
	} finally { await f.dispose(); }
});

async function requestSuggestions(f: Awaited<ReturnType<typeof fixture>>) {
	await f.press(" ", { ctrlKey: true });
	await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
	assert.equal(completionStatus(f.view.state), "active");
}

test("exercise suggestions accept with Tab in Vim Insert mode and keep submit isolated", async () => {
	const f = await fixture("library.fi", false, { completionContext: API_DEMO_CODE_CONTEXT });
	try {
		await f.press("A");
		assert.equal(f.cm.state.vim?.insertMode, true);
		await requestSuggestions(f);
		assert.deepEqual(currentCompletions(f.view.state).map(option => option.label), ["find_book"]);
		await f.press("Tab");
		assert.equal(f.view.state.doc.toString(), "library.find_book(book_id)");
		assert.equal(f.cm.state.vim?.insertMode, true);
		assert.deepEqual(f.counts(), { submissions: 0, ancestorKeys: 0, documentKeys: 0 });
		await f.press("Enter", { metaKey: true });
		assert.equal(f.counts().submissions, 1);
	} finally { await f.dispose(); }
});

test("Escape dismisses suggestions and exits Insert; Normal-mode keys do not open suggestions", async () => {
	const f = await fixture("library.", false, { completionContext: API_DEMO_CODE_CONTEXT });
	try {
		await f.press("A");
		await requestSuggestions(f);
		await f.press("Escape");
		assert.equal(completionStatus(f.view.state), null);
		assert.equal(f.cm.state.vim?.insertMode, false);
		await f.press(" ", { ctrlKey: true });
		assert.equal(completionStatus(f.view.state), null);
		assert.equal(f.view.state.doc.toString(), "library.");
	} finally { await f.dispose(); }
});

test("completion metadata updates preserve the document, selection, and Vim mode", async () => {
	const f = await fixture("library.");
	try {
		await f.press("A");
		const selection = f.view.state.selection.main.head;
		await f.render(false, { completionContext: API_DEMO_CODE_CONTEXT });
		assert.equal(f.view.state.doc.toString(), "library.");
		assert.equal(f.view.state.selection.main.head, selection);
		assert.equal(f.cm.state.vim?.insertMode, true);
		await requestSuggestions(f);
		assert.ok(currentCompletions(f.view.state).some(option => option.label === "borrow"));
	} finally { await f.dispose(); }
});

test("known API mistakes get squiggles that disappear when corrected", async () => {
	const f = await fixture("void f() { borrow(book_id); }", false, { completionContext: API_DEMO_CODE_CONTEXT });
	try {
		const messages: string[] = [];
		forEachDiagnostic(f.view.state, diagnostic => messages.push(diagnostic.message));
		assert.ok(messages.some(message => message.includes("library.borrow")));
		assert.ok(f.host.querySelector(".cm-lintRange-error"));
		await act(async () => f.view.dispatch({ changes: { from: 11, insert: "library." } }));
		const remaining: string[] = [];
		forEachDiagnostic(f.view.state, diagnostic => remaining.push(diagnostic.message));
		assert.deepEqual(remaining, []);
	} finally { await f.dispose(); }
});

test("compiler diagnostics disappear on the first edit and can refresh without resetting source", async () => {
	const source = "int main() { bad(); }";
	const f = await fixture(source, false, { diagnostics: [{ line: 1, column: 14, severity: "error", message: "Unknown function", source: "compiler" }] });
	try {
		let count = 0;
		forEachDiagnostic(f.view.state, () => count++);
		assert.equal(count, 1);
		await act(async () => f.view.dispatch({ changes: { from: 0, insert: " " } }));
		count = 0;
		forEachDiagnostic(f.view.state, () => count++);
		assert.equal(count, 0, "old compiler positions are not shown against an edited answer");
		await f.render(false, { diagnostics: [{ line: 1, column: 14, severity: "error", message: "Old snapshot" }] });
		assert.equal(f.view.state.doc.toString(), ` ${source}`);
		forEachDiagnostic(f.view.state, () => count++);
		assert.equal(count, 0);
	} finally { await f.dispose(); }
});

test("locking the editor closes completion choices and blocks new suggestions", async () => {
	const f = await fixture("library.fi", false, { completionContext: API_DEMO_CODE_CONTEXT });
	try {
		await f.press("A");
		await requestSuggestions(f);
		await f.render(true);
		assert.equal(completionStatus(f.view.state), null);
		await f.press(" ", { ctrlKey: true });
		await f.press("Tab");
		assert.equal(completionStatus(f.view.state), null);
		assert.equal(f.view.state.doc.toString(), "library.fi");
	} finally { await f.dispose(); }
});

test("qualified API suggestions rank before unqualified words copied from the draft", async () => {
	const f = await fixture("void borrow_book();\n// borrowed\nborr", false, { completionContext: API_DEMO_CODE_CONTEXT });
	try {
		await f.press("G");
		await f.press("A");
		await requestSuggestions(f);
		const options = currentCompletions(f.view.state).map(option => option.label);
		assert.ok(options.includes("library.borrow"));
		assert.ok(options.includes("borrowed"));
		assert.ok(options.indexOf("library.borrow") < options.indexOf("borrowed"));
		assert.ok(options.indexOf("BorrowResult::borrowed") < options.indexOf("borrow_book"));
	} finally { await f.dispose(); }
});

test("F1 shows only the diagnostic under the cursor without moving or cycling", async () => {
	const source = "bad();\nwrong();";
	const f = await fixture(source, false, { diagnostics: [
		{ line: 1, column: 1, endColumn: 4, severity: "error", message: "First problem" },
		{ line: 2, column: 1, endColumn: 6, severity: "warning", message: "Second problem" },
	] });
	try {
		for (const [position, message] of [[0, "First problem"], [1, "First problem"], [1, "First problem"], [7, "Second problem"], [9, "Second problem"]] as const) {
			await act(async () => f.view.dispatch({ selection: { anchor: position } }));
			const event = await f.press("F1");
			assert.equal(event.defaultPrevented, true);
			assert.equal(f.view.state.selection.main.from, position);
			assert.equal(f.view.state.selection.main.to, position);
			assert.equal(f.cm.state.vim?.visualMode, false);
			assert.match(f.host.querySelector(".cm-tooltip-lint")?.textContent ?? "", new RegExp(message));
		}
		for (const position of [3, 5, 12, source.length]) {
			await act(async () => f.view.dispatch({ selection: { anchor: position } }));
			// A mouse hover elsewhere must not remain as apparent F1 feedback.
			await act(async () => activateHover(f.view, 0, 1));
			assert.equal((await f.press("F1")).defaultPrevented, true);
			assert.equal(f.view.state.selection.main.head, position);
			assert.equal(f.host.querySelector(".cm-tooltip-lint"), null, "F1 outside a diagnostic does not jump to another one");
		}
		assert.equal(f.view.state.doc.toString(), source);
		assert.deepEqual(f.changes, []);
		assert.deepEqual(f.counts(), { submissions: 0, ancestorKeys: 0, documentKeys: 0 });
	} finally { await f.dispose(); }
});

test("F1 works in Insert mode and consumes the key harmlessly when there are no errors", async () => {
	const f = await fixture("okay");
	try {
		await f.press("i");
		const empty = await f.press("F1");
		assert.equal(empty.defaultPrevented, true);
		assert.equal(f.cm.state.vim?.insertMode, true);
		assert.equal(f.view.state.selection.main.head, 0);
		await f.render(false, { diagnostics: [{ line: 1, column: 2, endColumn: 5, severity: "error", message: "Inspect this symbol" }] });
		await act(async () => f.view.dispatch({ selection: { anchor: 2 } }));
		await f.press("F1");
		assert.equal(f.view.state.selection.main.from, 2);
		assert.equal(f.view.state.selection.main.to, 2);
		assert.match(f.host.querySelector(".cm-tooltip-lint")?.textContent ?? "", /Inspect this symbol/);
		assert.equal(f.cm.state.vim?.insertMode, true);
		assert.equal(f.view.state.doc.toString(), "okay");
		assert.deepEqual(f.counts(), { submissions: 0, ancestorKeys: 0, documentKeys: 0 });
	} finally { await f.dispose(); }
});
