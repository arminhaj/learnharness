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
const { EditorView } = await import("@codemirror/view");
const { getCM } = await import("@replit/codemirror-vim");

async function fixture(initialValue = "alpha beta\ngamma", initiallyDisabled = false) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const changes: string[] = [];
	let submissions = 0;
	let ancestorKeys = 0;
	let documentKeys = 0;
	const onDocumentKey = () => { documentKeys++; };
	document.addEventListener("keydown", onDocumentKey);
	const render = async (disabled: boolean) => {
		await act(async () => root.render(
			<div onKeyDown={() => { ancestorKeys++; }}>
				<CodeEditor value={initialValue} onChange={value => changes.push(value)} onSubmit={() => { submissions++; }} disabled={disabled} />
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
