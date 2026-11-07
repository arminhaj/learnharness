import React, { act } from "react";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { KetSerializer, type EditorSelection, type Ketcher } from "ketcher-core";
import type { MoleculeSource } from "../src/core/chemistry.ts";
import { ChemistryDialog } from "../components/chemistry/chemistry-dialog.tsx";
import { curvedArrowsKet } from "./fixtures/curved-arrows.ts";

async function waitFor(check: () => boolean, description: string) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		assert.ok(Date.now() < deadline, description);
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
	}
}

test("selected 3D previews preserve the complete drawing and return safely to the same editor", async () => {
	const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.assign(globalThis, {
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const prototype = dom.window.HTMLElement.prototype as HTMLElement & { showModal?: () => void; close?: () => void };
	prototype.showModal = function () { this.setAttribute("open", ""); };
	prototype.close = function () { this.removeAttribute("open"); };
	const originalAddEventListener = prototype.addEventListener;
	let cancelCapture: ((event: Event) => void) | undefined;
	prototype.addEventListener = function (this: HTMLElement, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
		if (type === "cancel" && (options === true || typeof options === "object" && options.capture) && listener) {
			cancelCapture = typeof listener === "function" ? listener.bind(this) : listener.handleEvent.bind(listener);
		}
		if (listener) originalAddEventListener.call(this, type, listener, options);
	} as typeof prototype.addEventListener;
	const captureKey = Symbol.for("learnharness.test.editor-3d-preview");
	type EditorProps = { onInit: (editor: Ketcher) => void };
	type Capture = { editor: (props: EditorProps) => void; preview: (source: MoleculeSource) => void };
	const globals = globalThis as typeof globalThis & { [captureKey]?: Capture };
	let editorProps: EditorProps | undefined;
	const previews: MoleculeSource[] = [];
	globals[captureKey] = { editor: props => { editorProps = props; }, preview: source => { previews.push(source); } };
	const moduleUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`;
	const vendorEditor = moduleUrl('export function Editor(props) { globalThis[Symbol.for("learnharness.test.editor-3d-preview")].editor(props); return globalThis.React.createElement("div", { "data-testid": "vendor-canvas" }); }');
	const viewer = moduleUrl('export default function Molecule3D({source}) { globalThis[Symbol.for("learnharness.test.editor-3d-preview")].preview(source); return globalThis.React.createElement("output", { "data-testid": "selected-model", "data-source": JSON.stringify(source) }, source.smiles); }');
	const standalone = moduleUrl("export class StandaloneStructServiceProvider {}");
	const empty = moduleUrl("export {};");
	// Mock vendor canvas and WebGL only; component selection, serialization,
	// preview lifecycle, original dialog, and event handling remain real.
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (context.parentURL?.includes("/components/chemistry/ketcher-editor")) {
				const url = specifier === "ketcher-react" ? vendorEditor
					: specifier === "ketcher-standalone" ? standalone
						: /^\.\/molecule-3d(?:\.tsx)?$/.test(specifier) ? viewer
							: specifier.endsWith(".css") ? empty : undefined;
				if (url) return { url, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	await import(viewer);
	const serializer = new KetSerializer();
	const ket = JSON.parse(curvedArrowsKet);
	ket.root.nodes.push({ $ref: "mol1" });
	ket.mol1 = { type: "molecule", atoms: [{ label: "N", charge: 1, location: [6, 0, 0] }] };
	const drawing = serializer.deserialize(JSON.stringify(ket));
	const original = serializer.serialize(drawing);
	let selection: EditorSelection | null = null;
	const listeners = new Set<() => void>();
	let setMoleculeCalls = 0;
	const editor = {
		getKet: async () => serializer.serialize(drawing),
		setMolecule: async () => { setMoleculeCalls++; },
		editor: { struct: () => drawing, selection: () => selection },
		changeEvent: {
			add: (listener: () => void) => { listeners.add(listener); },
			remove: (listener: () => void) => { listeners.delete(listener); },
		},
	} as unknown as Ketcher;
	let saves = 0;
	let drafts = 0;
	let closes = 0;
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try {
		const { default: KetcherEditor } = await import("../components/chemistry/ketcher-editor.tsx");
		await act(async () => { root.render(<ChemistryDialog title="Draw your answer" onClose={() => closes++}><KetcherEditor onSave={() => saves++} onChange={() => drafts++} onCancel={() => closes++} /></ChemistryDialog>); });
		assert.ok(editorProps);
		await act(async () => editorProps!.onInit(editor));
		const dialog = document.querySelector("dialog")!;
		const canvas = document.querySelector<HTMLElement>('[aria-label="Molecule drawing canvas"]')!;
		const vendorCanvas = canvas.querySelector('[data-testid="vendor-canvas"]')!;
		const toolbar = () => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => /View selected molecule in 3D|Back to drawing/.test(button.textContent!))!;
		const preview = () => document.querySelector('[data-testid="editor-3d-preview"]');
		const openPreview = async () => {
			await act(async () => toolbar().click());
			await waitFor(() => !!document.querySelector('[data-testid="selected-model"]'), "the selected component should reach the 3D viewer");
			return previews.at(-1)!;
		};
		for (const invalid of [null, { atoms: [0, 3] }, { rxnArrows: [0, 1] }]) {
			selection = invalid;
			await act(async () => toolbar().click());
			await waitFor(() => !!dialog.querySelector('[role="alert"]'), "an invalid selection should explain how to select one molecule");
			assert.equal(preview(), null);
			assert.equal(canvas.hidden, false);
		}
		selection = { atoms: [1], rxnArrows: [0, 1] };
		const first = await openPreview();
		assert.equal(first.smiles, "CCO", "partial selection previews its whole connected component");
		assert.equal(first.ket, undefined, "the viewer does not receive unrelated molecules or canvas annotations");
		assert.equal(document.querySelectorAll("dialog").length, 1, "preview uses the existing dialog");
		assert.equal(canvas.hidden, true);
		assert.equal(canvas.hasAttribute("inert"), true);
		assert.equal(canvas.querySelector('[data-testid="vendor-canvas"]'), vendorCanvas);
		assert.equal(serializer.serialize(drawing), original);
		assert.equal(saves, 0);
		assert.equal(drafts, 0);
		assert.equal(setMoleculeCalls, 0);
		await act(async () => toolbar().click());
		assert.equal(preview(), null);
		assert.equal(canvas.hidden, false);
		assert.equal(canvas.querySelector('[data-testid="vendor-canvas"]'), vendorCanvas);
		selection = { atoms: [3] };
		assert.equal((await openPreview()).smiles, "[NH4+]", "a later preview reads the current selection");
		const escape = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(escape, { key: "Escape" });
		await act(async () => { toolbar().dispatchEvent(escape); });
		assert.equal(escape.defaultPrevented, true);
		assert.equal(preview(), null);
		assert.equal(closes, 0, "Escape returns to the drawing instead of closing it");
		await openPreview();
		const cancel = new window.Event("cancel", { cancelable: true });
		// Linkedom dispatches same-target listeners in registration order,
		// ignoring capture=true. Run the real capture handler first as browsers do.
		assert.ok(cancelCapture);
		await act(async () => { cancelCapture!(cancel); dialog.dispatchEvent(cancel); });
		assert.equal(cancel.defaultPrevented, true);
		assert.equal(preview(), null);
		assert.equal(closes, 0, "native dialog cancellation from the iframe closes only its preview");
		selection = { atoms: [0] };
		await openPreview();
		drawing.rxnArrows.get(0)!.height = 1.8;
		await act(async () => listeners.forEach(changed => changed()));
		assert.equal(preview(), null, "an asynchronous canvas edit invalidates the old model");
		assert.equal(canvas.hidden, false);
		assert.equal(drawing.atoms.size, 4);
		assert.equal(drawing.rxnArrows.size, 2);
		assert.equal(drawing.rxnArrows.get(0)!.height, 1.8);
		assert.equal(setMoleculeCalls, 0);
		assert.equal(saves, 0);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		hook.deregister();
		delete globals[captureKey];
		delete prototype.showModal;
		delete prototype.close;
		prototype.addEventListener = originalAddEventListener;
	}
});
