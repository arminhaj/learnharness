import React, { act } from "react";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { MoleculeReference, MoleculeSource } from "../src/core/index.ts";

class Transfer {
	data = new Map<string, string>();
	effectAllowed = "uninitialized";
	dropEffect = "none";
	get types() { return [...this.data.keys()]; }
	getData(type: string) { return this.data.get(type) ?? ""; }
	setData(type: string, value: string) { this.data.set(type, value); }
}

test("reference sidebar copies, pastes, renames, removes, and routes only internal selection drops", async () => {
	const dom = parseHTML("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
	Object.assign(dom.document, { oninput: null });
	const copied: string[] = [];
	let failCopy = false;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
		navigator: { userAgent: "node", clipboard: { writeText: async (value: string) => { if (failCopy) throw new Error("Clipboard unavailable"); copied.push(value); } } },
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const renderer = `data:text/javascript,${encodeURIComponent('export async function drawMolecule() { return \'<svg xmlns="http://www.w3.org/2000/svg"><text>molecule</text></svg>\'; }')}`;
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (context.parentURL?.includes("/components/chemistry/molecule-reference-sidebar") && /^\.\/rdkit-client(?:\.tsx?|\.js)?$/.test(specifier)) return { url: renderer, shortCircuit: true };
			return nextResolve(specifier, context);
		},
	});
	const { createRoot } = await import("react-dom/client");
	const { MoleculeReferenceSidebar, SelectedMoleculeDrag, readMoleculeDrag, MOLECULE_DRAG_MIME } = await import("../components/chemistry/molecule-reference-sidebar.tsx");
	const problem: MoleculeReference = { id: "problem-1", name: "Starting material", source: { smiles: "CCO" } };
	const intermediate: MoleculeReference = { id: "saved-1", name: "Intermediate 1", source: { smiles: "CC=O" } };
	const selected = { token: "selection-4", source: { smiles: "C[NH3+]" } };
	const pasted: MoleculeSource[] = [];
	const renamed: [string, string][] = [];
	const removed: string[] = [];
	const dropped: string[] = [];
	let savedSelections = 0;
	let failInsert = false;
	let saved = [intermediate];
	const host = document.getElementById("root")!;
	const root = createRoot(host);
	let options: { disabled: boolean; selected: typeof selected | undefined } = { disabled: false, selected };
	const render = async () => {
		await act(async () => {
			root.render(<><MoleculeReferenceSidebar problemReferences={[problem]} savedReferences={saved} selected={options.selected} disabled={options.disabled}
				onInsert={async source => { if (failInsert) throw new Error("Canvas is busy"); pasted.push(source); }}
				onSaveSelected={async () => { savedSelections++; }}
				onRenameReference={(id, name) => { renamed.push([id, name]); saved = saved.map(item => item.id === id ? { ...item, name } : item); }}
				onRemoveReference={id => { removed.push(id); saved = saved.filter(item => item.id !== id); }}
				onReferenceDrop={async token => { dropped.push(token); }} />
			<SelectedMoleculeDrag selected={options.selected} disabled={options.disabled} /></>);
		});
	};
	const click = async (label: string) => {
		const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent === label)!;
		assert.ok(button, `missing ${label}`);
		await act(async () => { button.click(); });
	};
	const drag = async (target: Element, type: string, transfer: Transfer) => {
		const event = new window.Event(type, { bubbles: true, cancelable: true });
		Object.assign(event, { dataTransfer: transfer });
		await act(async () => { target.dispatchEvent(event); });
		return event;
	};
	try {
		await render();
		assert.ok(host.querySelector('section[aria-label="Problem structures"]'));
		assert.ok(host.querySelector('section[aria-label="My intermediates"]'));
		assert.equal(host.querySelectorAll("img").length, 3, "problem, saved, and selected molecules get local previews");
		assert.equal(host.querySelectorAll('img[draggable="false"]').length, 3, "native SVG/image dragging never leaks image URLs");
		await click("Copy Starting material");
		assert.deepEqual(copied, ["CCO"]);
		await click("Paste Starting material into drawing");
		assert.deepEqual(pasted, [problem.source]);
		await click("Save selected molecule");
		assert.equal(savedSelections, 1);
		await click("Copy selected");
		assert.deepEqual(copied, ["CCO", "C[NH3+]"]);

		const referenceDrag = new Transfer();
		await drag(host.querySelector('[aria-label="Drag Starting material into drawing"]')!, "dragstart", referenceDrag);
		assert.equal(referenceDrag.effectAllowed, "copy");
		assert.deepEqual(readMoleculeDrag(referenceDrag), { type: "reference", id: "problem-1" });
		assert.equal(referenceDrag.getData("text/plain"), "", "drag data contains no externally supplied chemistry");
		const selectionDrag = new Transfer();
		await drag(host.querySelector('[aria-label="Drag Selected molecule into drawing"]')!, "dragstart", selectionDrag);
		assert.deepEqual(readMoleculeDrag(selectionDrag), { type: "selection", token: "selection-4" });
		const sidebar = host.querySelector('[aria-label="Molecule references"]')!;
		assert.equal((await drag(sidebar, "dragover", selectionDrag)).defaultPrevented, true);
		assert.equal(selectionDrag.dropEffect, "copy");
		await drag(sidebar, "drop", selectionDrag);
		assert.deepEqual(dropped, ["selection-4"], "root receives only the opaque selection token for freshness checks");
		await drag(sidebar, "drop", referenceDrag);
		assert.deepEqual(dropped, ["selection-4"], "dragging a reference back into the bank does not create another intermediate");
		const forged = new Transfer();
		forged.setData(MOLECULE_DRAG_MIME, JSON.stringify({ type: "selection", token: "foreign", source: { smiles: "CO" } }));
		assert.equal(readMoleculeDrag(forged), null);
		await drag(sidebar, "drop", forged);
		assert.deepEqual(dropped, ["selection-4"]);
		const external = new Transfer(); external.setData("text/plain", "CCO");
		assert.equal((await drag(sidebar, "drop", external)).defaultPrevented, false);
		assert.equal(readMoleculeDrag({ getData: () => "bad json" }), null);
		assert.equal(readMoleculeDrag({ getData: () => JSON.stringify({ type: "reference", id: "" }) }), null);

		await click("Rename Intermediate 1");
		const name = host.querySelector<HTMLInputElement>('[aria-label="Name for Intermediate 1"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(name, "Carbonyl intermediate");
			name.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await click("Save name");
		assert.deepEqual(renamed, [["saved-1", "Carbonyl intermediate"]]);
		await render();
		await click("Remove Carbonyl intermediate");
		assert.deepEqual(removed, ["saved-1"]);
		await render();
		assert.equal(host.querySelector('article[aria-label="Carbonyl intermediate"]'), null);
		assert.equal(host.querySelector('[aria-label="Rename Starting material"]'), null, "problem references are not editable");

		failInsert = true;
		await click("Paste Starting material into drawing");
		assert.match(host.querySelector('aside [role="alert"]')!.textContent!, /Canvas is busy/);
		failCopy = true;
		await click("Copy Starting material");
		assert.match(host.querySelector('aside [role="alert"]')!.textContent!, /Use Paste into drawing/);

		options = { disabled: false, selected: undefined };
		await render();
		assert.equal([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save selected molecule")!.disabled, true);
		assert.equal(host.querySelector('[data-testid="selected-molecule-drag"]'), null);
		options = { disabled: true, selected };
		await render();
		assert.ok([...host.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled));
		const disabledDrag = new Transfer();
		assert.equal((await drag(host.querySelector('[aria-label="Drag Starting material into drawing"]')!, "dragstart", disabledDrag)).defaultPrevented, true);
		assert.deepEqual(disabledDrag.types, []);
		await drag(host.querySelector("aside")!, "drop", selectionDrag);
		assert.deepEqual(dropped, ["selection-4"], "disabled editors cannot modify reference banks through drops");
	} finally {
		await act(async () => { root.unmount(); });
		hook.deregister();
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	}
});
