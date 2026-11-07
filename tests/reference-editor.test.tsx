import React, { act } from "react";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import { KetSerializer, ReStruct, Struct, type Action, type EditorSelection, type Ketcher } from "ketcher-core";
import type { MoleculeReference } from "../src/core/index.ts";
import { curvedArrowsKet, ethanolKet } from "./fixtures/curved-arrows.ts";

interface Pipeline<T> { add(handler: (value: T) => T): void; remove(handler: (value: T) => T): void; dispatch(value: T): T; handlers: unknown[] }
interface EventSubscription { add(handler: () => void): void; remove(handler: () => void): void; dispatch(): void; handlers: unknown[] }
const require = createRequire(import.meta.url);
const { PipelineSubscription, Subscription } = require("subscription") as {
	PipelineSubscription: new <T>() => Pipeline<T>;
	Subscription: new () => EventSubscription;
};

class Transfer {
	data = new Map<string, string>();
	effectAllowed = "uninitialized";
	dropEffect = "none";
	get types() { return [...this.data.keys()]; }
	getData(type: string) { return this.data.get(type) ?? ""; }
	setData(type: string, value: string) { this.data.set(type, value); }
}

async function waitFor(check: () => boolean, message: string) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		assert.ok(Date.now() < deadline, message);
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
	}
}

test("reference selections remain immutable, tokens expire across edits and steps, and root clipboard fallback inserts safely", async () => {
	const dom = parseHTML("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
	Object.assign(dom.document, { oninput: null });
	const clipboardWrites: string[] = [];
	let readClipboard: () => Promise<string> = async () => { throw new Error("Clipboard permission unavailable"); };
	const storage = new Map<string, string>();
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
		HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
		Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
		navigator: { userAgent: "node", clipboard: { readText: () => readClipboard(), writeText: async (text: string) => { clipboardWrites.push(text); } } },
		localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const capture = Symbol.for("learnharness.test.reference-editor");
	type VendorProps = { onInit: (editor: Ketcher) => void };
	const globals = globalThis as typeof globalThis & { [capture]?: (props: VendorProps) => void };
	let vendorProps: VendorProps | undefined;
	globals[capture] = props => { vendorProps = props; };
	const url = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
	const vendor = url('export function Editor(props) { globalThis[Symbol.for("learnharness.test.reference-editor")](props); return globalThis.React.createElement("div", { "data-testid": "vendor-canvas" }); }');
	const provider = url("export class StandaloneStructServiceProvider {}");
	const empty = url("export {};");
	const renderer = url('export async function drawMolecule() { return \'<svg xmlns="http://www.w3.org/2000/svg"><text>reference</text></svg>\'; }');
	const hook = registerHooks({ resolve(specifier, context, nextResolve) {
		if (context.parentURL?.includes("/components/chemistry/ketcher-editor")) {
			const replacement = specifier === "ketcher-react" ? vendor : specifier === "ketcher-standalone" ? provider : specifier.endsWith(".css") ? empty : undefined;
			if (replacement) return { url: replacement, shortCircuit: true };
		}
		if (context.parentURL?.includes("/components/chemistry/") && /^\.\/rdkit-client(?:\.tsx?|\.js)?$/.test(specifier)) return { url: renderer, shortCircuit: true };
		return nextResolve(specifier, context);
	} });
	const serializer = new KetSerializer();
	const initial = JSON.parse(curvedArrowsKet);
	initial.root.nodes.push({ $ref: "mol1" });
	initial.mol1 = { type: "molecule", atoms: [{ label: "N", charge: 1, location: [6, 0, 0] }], bonds: [] };
	let drawing = serializer.deserialize(JSON.stringify(initial));
	let selection: EditorSelection | null = null;
	const selectionChange = new PipelineSubscription<EditorSelection | null>();
	const changeEvent = new Subscription();
	const history: Action[] = [];
	const path = { attr() { return this; }, toFront() { return this; } };
	const render = {
		paper: { rect: () => path }, options: { zoom: 1, microModeScale: 40 },
		viewBox: { minX: 0, minY: 0, width: 800, height: 600 },
		clientArea: { getBoundingClientRect: () => ({ left: 100, top: 50 }) },
	} as unknown as Ketcher["editor"]["render"];
	const replaceDrawing = (next: Struct) => { drawing = next; render.ctab = new ReStruct(drawing, render); };
	replaceDrawing(drawing);
	const editor = {
		getKet: async () => serializer.serialize(drawing),
		setMolecule: async (source: string) => { replaceDrawing(serializer.deserialize(source)); changeEvent.dispatch(); },
		structService: { convert: async () => ({ struct: ethanolKet }), layout: async () => ({ struct: ethanolKet }) },
		changeEvent,
		editor: {
			struct: () => drawing, options: () => ({}), render, event: { selectionChange },
			selection(value?: EditorSelection | null) {
				if (arguments.length) { selection = value ?? null; selectionChange.dispatch(selection); }
				return selection;
			},
			clear: () => { replaceDrawing(new Struct()); changeEvent.dispatch(); },
			clearHistory: () => { history.length = 0; },
			update: (action: Action) => { history.push(action); changeEvent.dispatch(); },
		},
	} as unknown as Ketcher;
	const banks: MoleculeReference[][] = [];
	const { createRoot } = await import("react-dom/client");
	const { default: KetcherEditor } = await import("../components/chemistry/ketcher-editor.tsx");
	const { readMoleculeDrag, writeMoleculeDrag } = await import("../components/chemistry/molecule-reference-sidebar.tsx");
	const host = document.getElementById("root")!;
	const root = createRoot(host);
	const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
	const click = async (text: string) => { assert.ok(button(text), `missing button ${text}`); await act(async () => { button(text).click(); }); };
	const select = async (value: EditorSelection | null) => { await act(async () => { editor.editor.selection(value); }); };
	const selectedPreview = () => host.querySelector('[aria-label="Drag Selected molecule into drawing"]');
	const drag = async (target: Element, type: string, transfer: Transfer) => {
		const event = new window.Event(type, { bubbles: true, cancelable: true });
		Object.assign(event, { dataTransfer: transfer, clientX: 300, clientY: 150 });
		await act(async () => { target.dispatchEvent(event); });
	};
	const selectedTransfer = async () => {
		await waitFor(() => !!selectedPreview(), "a valid single-molecule selection should produce its preview after the debounce");
		const transfer = new Transfer();
		await drag(selectedPreview()!, "dragstart", transfer);
		assert.equal(readMoleculeDrag(transfer)?.type, "selection");
		return transfer;
	};
	let propagatedSelection: EditorSelection | null | undefined;
	const afterReferenceListener = (value: EditorSelection | null) => { propagatedSelection = value; return value; };
	try {
		await act(async () => { root.render(<KetcherEditor onSave={() => {}} onCancel={() => {}} onReferencesChange={value => banks.push(value)} />); });
		assert.ok(vendorProps);
		await act(async () => { vendorProps!.onInit(editor); });
		await waitFor(() => !button("Add step").disabled, "the fake vendor editor should finish initialization");
		selectionChange.add(afterReferenceListener);
		const before = serializer.serialize(drawing);
		await select({ atoms: [1], rxnArrows: [0, 1] });
		assert.deepEqual(propagatedSelection, { atoms: [1], rxnArrows: [0, 1] }, "the reference observer must preserve values passed to later vendor pipeline listeners");
		assert.equal(selectedPreview(), null, "selection rendering is debounced");
		const firstDrag = await selectedTransfer();
		await click("Save selected molecule");
		assert.equal(banks.length, 1);
		assert.equal(banks[0]!.length, 1);
		const savedKet = banks[0]![0]!.source.ket!;
		const savedMolecule = serializer.deserialize(savedKet);
		assert.equal(savedMolecule.atoms.size, 3, "selecting one atom saves its whole connected molecule");
		assert.equal(savedMolecule.rxnArrows.size, 0, "unrelated drawing arrows and other molecules stay out of the bank");
		assert.equal(serializer.serialize(drawing), before, "saving a reference never mutates the canvas");
		await click("Copy selected");
		assert.match(clipboardWrites[0]!, /M  END/);

		drawing.atoms.get(2)!.charge = 1;
		await act(async () => { changeEvent.dispatch(); });
		assert.equal(selectedPreview(), null, "an edit invalidates the old selected preview immediately");
		await drag(host.querySelector("aside")!, "drop", firstDrag);
		assert.equal(banks.length, 1);
		assert.match(host.querySelector('aside [role="alert"]')!.textContent!, /Select an atom or bond/);
		assert.equal(banks[0]![0]!.source.ket, savedKet, "later canvas edits do not rewrite a saved reference");
		const secondDrag = await selectedTransfer();
		await drag(host.querySelector("aside")!, "drop", secondDrag);
		assert.equal(banks.at(-1)!.length, 2, "a fresh drag stores a second immutable intermediate");
		assert.notEqual(banks.at(-1)![1]!.source.ket, savedKet);

		await click("Add step");
		await waitFor(() => !button("Add step").disabled, "step change should finish");
		assert.equal(drawing.atoms.size, 0);
		await drag(host.querySelector("aside")!, "drop", secondDrag);
		assert.equal(banks.at(-1)!.length, 2, "a drag token cannot be reused after changing steps");
		assert.equal(button("Save selected molecule").disabled, true);
		await click("Step 1");
		await waitFor(() => !button("Add step").disabled, "return to the first step");
		assert.equal(drawing.atoms.size, 4);
		await select({ atoms: [0, 3] });
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
		assert.equal(selectedPreview(), null, "a selection spanning separate molecules cannot be stored");

		await click("Paste");
		const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Paste molecular structure"]')!;
		assert.ok(input, "clipboard denial opens the manual paste field");
		await act(async () => {
			Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "CCO");
			input.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		assert.equal(button("Insert pasted structure").disabled, false);
		const beforePaste = serializer.serialize(drawing);
		await act(async () => { input.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
		await waitFor(() => !host.querySelector('[aria-label="Paste molecular structure"]'), "manual insertion should return to the canvas");
		assert.equal(drawing.atoms.size, 7);
		assert.equal(history.length, 1, "the root manual-paste flow uses the undoable insertion helper");
		assert.equal(drawing.rxnArrows.size, 2);
		history[0]!.perform(render.ctab);
		await act(async () => { changeEvent.dispatch(); });
		assert.equal(serializer.serialize(drawing), beforePaste, "one undo restores all original molecules and arrows");

		// A successful clipboard read must not land in a different step opened while permission was pending.
		let finishRead!: (text: string) => void;
		readClipboard = () => new Promise(resolve => { finishRead = resolve; });
		await click("Paste");
		assert.ok(finishRead);
		await click("Add step");
		await waitFor(() => !button("Add step").disabled, "the new step should open while clipboard permission is pending");
		await act(async () => { finishRead("CCO"); });
		await waitFor(() => !!host.querySelector('[role="alert"]'), "a stale clipboard read should explain that the drawing changed");
		assert.equal(drawing.atoms.size, 0, "clipboard completion never inserts into a step the user did not target");
		assert.equal(history.length, 0);
		assert.match([...host.querySelectorAll('[role="alert"]')].map(item => item.textContent).join(" "), /drawing changed while reading the clipboard/i);

		const staleCanvasDrop = new Transfer();
		const stalePayload = readMoleculeDrag(firstDrag)!;
		writeMoleculeDrag(staleCanvasDrop as unknown as DataTransfer, stalePayload);
		await drag(host.querySelector('[data-testid="vendor-canvas"]')!, "drop", staleCanvasDrop);
		assert.equal(drawing.atoms.size, 0, "stale selection drops onto the canvas cannot copy an old step implicitly");
	} finally {
		selectionChange.remove(afterReferenceListener);
		await act(async () => { root.unmount(); });
		assert.equal(selectionChange.handlers.length, 0, "the hook releases its vendor selection listener");
		assert.equal(changeEvent.handlers.length, 0, "the editor and hook both release drawing-change listeners");
		hook.deregister(); delete globals[capture];
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	}
});
