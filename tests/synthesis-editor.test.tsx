import React, { act } from "react";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import { KetSerializer, Struct, type Ketcher } from "ketcher-core";
import type { MoleculeDocument } from "../src/core/chemistry.ts";
import type { StructureEditorDraft, SynthesisEditorDraft } from "../components/chemistry/synthesis-draft.ts";
import { curvedArrowsKet } from "./fixtures/curved-arrows.ts";

async function waitFor(check: () => boolean, description: string) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		assert.ok(Date.now() < deadline, description);
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
	}
}

test("synthesis tabs keep separate arrow drawings, save every step, and recover removed steps", async () => {
	const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.assign(dom.document, { oninput: null });
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true });
	const { createRoot } = await import("react-dom/client");
	type EditorProps = { onInit: (editor: Ketcher) => void };
	const captureKey = Symbol.for("learnharness.test.synthesis-editor");
	const globals = globalThis as typeof globalThis & { [captureKey]?: (props: EditorProps) => void };
	let props: EditorProps | undefined;
	globals[captureKey] = value => { props = value; };
	const url = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
	const vendor = url('export function Editor(props) { globalThis[Symbol.for("learnharness.test.synthesis-editor")](props); return globalThis.React.createElement("div", {"data-testid":"vendor-canvas"}); }');
	const provider = url("export class StandaloneStructServiceProvider {}");
	const empty = url("export {};");
	const hook = registerHooks({ resolve(specifier, context, nextResolve) {
		if (context.parentURL?.includes("/components/chemistry/ketcher-editor")) {
			const replacement = specifier === "ketcher-react" ? vendor : specifier === "ketcher-standalone" ? provider : specifier.endsWith(".css") ? empty : undefined;
			if (replacement) return { url: replacement, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	} });
	const serializer = new KetSerializer();
	let drawing = serializer.deserialize(curvedArrowsKet);
	const original = serializer.serialize(drawing);
	const listeners = new Set<() => void>();
	let historyResets = 0;
	let rejectNextLoad = false;
	let loadBarrier: Promise<void> | undefined;
	let loadStarted = false;
	const editor = {
		getKet: async () => serializer.serialize(drawing),
		setMolecule: async (ket: string) => {
			if (rejectNextLoad) { rejectNextLoad = false; throw new Error("Could not open target step"); }
			if (loadBarrier) { const barrier = loadBarrier; loadBarrier = undefined; loadStarted = true; await barrier; }
			drawing = serializer.deserialize(ket); listeners.forEach(listener => listener());
		},
		editor: { struct: () => drawing, selection: () => null, clear: () => { drawing = new Struct(); listeners.forEach(listener => listener()); }, clearHistory: () => { historyResets++; } },
		changeEvent: { add: (listener: () => void) => listeners.add(listener), remove: (listener: () => void) => listeners.delete(listener) },
	} as unknown as Ketcher;
	const originalFetch = globalThis.fetch;
	const normalized: MoleculeDocument[] = [];
	globalThis.fetch = (async (input, init) => {
		assert.equal(input, "/api/chemistry/normalize");
		const body = JSON.parse(String(init?.body)) as MoleculeDocument;
		normalized.push(body);
		return Response.json(body);
	}) as typeof fetch;
	const drafts: (StructureEditorDraft | null)[] = [];
	const saved: MoleculeDocument[] = [];
	const host = document.createElement("div"); document.body.append(host);
	let root = createRoot(host);
	const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent === text)!;
	const tab = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(value => value.textContent === text)!;
	const changeFinished = async () => waitFor(() => button("Add step").disabled === false, "step transition should finish");
	try {
		const { default: KetcherEditor } = await import("../components/chemistry/ketcher-editor.tsx");
		await act(async () => { root.render(<KetcherEditor onChange={value => drafts.push(value)} onSave={value => saved.push(value)} onCancel={() => {}} />); });
		await act(async () => { props!.onInit(editor); });
		await act(async () => { button("Add step").click(); });
		await changeFinished();
		assert.equal(host.querySelectorAll('[role="tab"]').length, 2);
		assert.equal(tab("Step 2").getAttribute("aria-selected"), "true");
		assert.equal(drawing.atoms.size, 0, "new steps open a separate empty canvas");
		const emptyDraft = drafts.at(-1) as SynthesisEditorDraft;
		assert.equal(emptyDraft.kind, "synthesis-draft");
		assert.equal(emptyDraft.steps[0]!.ket, original, "the outgoing arrows are captured before clearing");
		assert.equal(emptyDraft.steps[1]!.ket, undefined, "an empty draft tab remains representable");
		await act(async () => { button("Use synthesis").click(); });
		await waitFor(() => !!host.querySelector('[role="alert"]'), "saving an empty step must explain which step needs a structure");
		assert.match(host.querySelector('[role="alert"]')!.textContent!, /Step 2/);
		assert.equal(saved.length, 0);

		drawing = serializer.deserialize(JSON.stringify({ root: { nodes: [{ $ref: "mol0" }] }, mol0: { type: "molecule", atoms: [{ label: "N", charge: 1, location: [3, 2, 0] }], bonds: [] } }));
		const second = serializer.serialize(drawing);
		await act(async () => { listeners.forEach(listener => listener()); tab("Step 1").click(); });
		await changeFinished();
		assert.equal(serializer.serialize(drawing), original, "returning to Step 1 restores its original arrows");
		await act(async () => { button("Rename step").click(); });
		await act(async () => {
			const input = host.querySelector<HTMLInputElement>('[aria-label="Step name"]')!;
			Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "Protonation");
			input.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await act(async () => { host.querySelector<HTMLFormElement>('form:has([aria-label="Step name"])')!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
		await changeFinished();
		assert.ok(tab("Protonation"));
		await act(async () => { button("Duplicate step").click(); });
		await changeFinished();
		assert.equal(serializer.serialize(drawing), original);
		assert.equal(host.querySelectorAll('[role="tab"]').length, 3);
		await act(async () => { button("Remove step").click(); });
		await changeFinished();
		assert.equal(host.querySelectorAll('[role="tab"]').length, 2);
		await act(async () => { button("Undo removal").click(); });
		await changeFinished();
		assert.equal(host.querySelectorAll('[role="tab"]').length, 3);
		assert.equal(serializer.serialize(drawing), original);
		await act(async () => { tab("Step 2").click(); });
		await changeFinished();
		assert.equal(serializer.serialize(drawing), second, "the other molecule never merges into the first step");
		await act(async () => { button("Use synthesis").click(); });
		await waitFor(() => saved.length === 1, "a complete synthesis should reach onSave");
		assert.deepEqual(saved[0]!.steps!.map(step => step.name), ["Protonation", "Protonation (copy)", "Step 2"]);
		assert.equal(saved[0]!.steps![0]!.ket, original);
		assert.equal(saved[0]!.steps![1]!.ket, original);
		assert.equal(saved[0]!.steps![2]!.ket, second);
		assert.equal(saved[0]!.ket, original, "legacy root fields mirror the first step");
		assert.equal(normalized.at(-1)!.steps!.length, 3, "validation receives every step together");
		assert.ok(historyResets >= 5, "undo history cannot cross step boundaries");

		// A failed removal restores the tab without offering an invalid undo.
		await act(async () => { root.render(<KetcherEditor key="clean-document" initial={saved[0]} onChange={value => drafts.push(value)} onSave={value => saved.push(value)} onCancel={() => {}} />); });
		await act(async () => { props!.onInit(editor); });
		await changeFinished();
		rejectNextLoad = true;
		await act(async () => { button("Remove step").click(); });
		await changeFinished();
		assert.equal(host.querySelectorAll('[role="tab"]').length, 3);
		assert.match(host.querySelector('[role="alert"]')!.textContent!, /Could not open target/);
		assert.equal(button("Undo removal"), undefined, "a rolled-back removal cannot create duplicate IDs");

		// Closing during a load must retain a tab operation on a clean document.
		let finishLoad!: () => void;
		loadBarrier = new Promise<void>(resolve => { finishLoad = resolve; });
		const beforeClose = drafts.length;
		await act(async () => { button("Duplicate step").click(); });
		await waitFor(() => loadStarted, "duplicate should start loading its own canvas");
		assert.equal(host.querySelectorAll('[role="tab"]').length, 4);
		await act(async () => { root.unmount(); });
		await waitFor(() => drafts.length > beforeClose, "closing should persist the proposed sequence before target load finishes");
		const closingDraft = drafts.at(-1) as SynthesisEditorDraft;
		assert.equal(closingDraft.steps.length, 4);
		assert.equal(closingDraft.steps[1]!.ket, original);
		finishLoad();
		await act(async () => { await Promise.resolve(); });

		// Recovering from a bad initial source still subscribes to later edits.
		root = createRoot(host);
		await act(async () => { root.render(<KetcherEditor initial={{ smiles: "invalid initial source" }} onChange={value => drafts.push(value)} onSave={() => {}} onCancel={() => {}} />); });
		await act(async () => { props!.onInit(editor); });
		await waitFor(() => !!host.querySelector('[role="alert"]'), "invalid initial source should be explained");
		drawing = serializer.deserialize(original);
		await act(async () => { listeners.forEach(listener => listener()); });
		const beforeRecovery = drafts.length;
		await act(async () => { root.unmount(); });
		await waitFor(() => drafts.length > beforeRecovery, "a corrected drawing must survive close after an initial load failure");
		const corrected = drafts.at(-1);
		assert.ok(corrected && !("kind" in corrected));
		assert.equal(corrected.ket, original);
	} finally {
		await act(async () => { root.unmount(); });
		host.remove(); hook.deregister(); delete globals[captureKey]; globalThis.fetch = originalFetch;
	}
});
