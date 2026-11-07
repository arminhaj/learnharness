import React, { act } from "react";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChemistryAnswerProvider } from "../components/chemistry/answer-context.tsx";
import type { StructureEditorProps } from "../components/chemistry/structure-editor.tsx";
import type { MoleculeSource } from "../src/core/chemistry.ts";

async function waitFor(check: () => boolean, description: string) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		assert.ok(Date.now() < deadline, description);
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
	}
}

test("saved synthesis tabs scope depiction, copy and 3D to the step while retaining the complete answer and editable sequence", async () => {
	const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.assign(globalThis, {
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const prototype = dom.window.HTMLElement.prototype as HTMLElement & { showModal?: () => void; close?: () => void };
	prototype.showModal = function () { this.setAttribute("open", ""); };
	prototype.close = function () { this.removeAttribute("open"); };
	const captureKey = Symbol.for("learnharness.test.synthesis-figure");
	type Capture = {
		draw: (source: MoleculeSource) => void;
		preview: (source: MoleculeSource) => void;
		edit: (props: StructureEditorProps) => void;
		copy: (text: string) => void;
	};
	const globals = globalThis as typeof globalThis & { [captureKey]?: Capture };
	const drawings: MoleculeSource[] = [];
	const previews: MoleculeSource[] = [];
	const editors: StructureEditorProps[] = [];
	const copies: string[] = [];
	globals[captureKey] = {
		draw: source => drawings.push(source), preview: source => previews.push(source),
		edit: props => editors.push(props), copy: text => copies.push(text),
	};
	const moduleUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`;
	// Substitute rendering/clipboard/editor boundaries only. The figure's tab
	// state, action source routing, dialog lifecycle and answer context are real.
	const depiction = moduleUrl(`export async function drawMolecule(source) { globalThis[Symbol.for("learnharness.test.synthesis-figure")].draw(source); return '<svg xmlns="http://www.w3.org/2000/svg"></svg>'; }`);
	const preview = moduleUrl('export default function Molecule3D({source}) { globalThis[Symbol.for("learnharness.test.synthesis-figure")].preview(source); return globalThis.React.createElement("output", {"data-testid":"step-model"}, source.smiles); }');
	const editor = moduleUrl('export default function StructureEditor(props) { globalThis[Symbol.for("learnharness.test.synthesis-figure")].edit(props); return globalThis.React.createElement("output", {"data-testid":"synthesis-editor"}); }');
	const clipboard = moduleUrl('export async function copyText(text) { globalThis[Symbol.for("learnharness.test.synthesis-figure")].copy(text); return true; }');
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (context.parentURL?.includes("/components/chemistry/molecule-figure")) {
				const url = /^\.\/rdkit-client(?:\.ts)?$/.test(specifier) ? depiction
					: /^\.\/molecule-3d(?:\.tsx)?$/.test(specifier) ? preview
						: /^\.\/structure-editor(?:\.tsx)?$/.test(specifier) ? editor
							: specifier === "@/components/copy-text" ? clipboard : undefined;
				if (url) return { url, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	await Promise.all([import(preview), import(editor)]);
	const source: MoleculeSource = {
		version: 1, smiles: "CCO", label: "Ethanol oxidation",
		steps: [
			{ id: "starting", name: "Starting material", smiles: "CCO", label: "Ethanol", caption: "The alcohol." },
			{ id: "product", name: "Product", smiles: "CC=O", label: "Acetaldehyde", caption: "The aldehyde." },
		],
	};
	const original = JSON.stringify(source);
	const answers: MoleculeSource[] = [];
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try {
		const { MoleculeFigure } = await import("../components/chemistry/molecule-figure.tsx");
		await act(async () => root.render(<ChemistryAnswerProvider onUse={value => answers.push(value)}><MoleculeFigure source={source} /></ChemistryAnswerProvider>));
		await waitFor(() => !!host.querySelector("img"), "the first step should finish depiction");
		const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
		const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === name)!;
		assert.deepEqual(tabs().map(tab => tab.textContent), ["Starting material", "Product"]);
		assert.equal(tabs()[0]!.getAttribute("aria-selected"), "true");
		assert.equal(host.querySelectorAll("figcaption").length, 1, "the sequence label appears once");
		assert.equal(host.querySelector("figcaption")!.textContent, source.label);
		assert.equal(drawings.at(-1)!.smiles, "CCO");
		assert.equal(drawings.at(-1)!.steps, undefined, "the depiction engine receives only the selected step");
		assert.match(host.textContent!, /The alcohol\./);
		const next = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(next, { key: "ArrowRight" });
		await act(async () => tabs()[0]!.dispatchEvent(next));
		await waitFor(() => drawings.at(-1)?.smiles === "CC=O" && !!host.querySelector("img"), "keyboard navigation should depict the second step");
		assert.equal(next.defaultPrevented, true);
		assert.equal(tabs()[1]!.getAttribute("aria-selected"), "true");
		assert.equal(tabs()[1]!.getAttribute("tabindex"), "0");
		const panel = host.querySelector('[role="tabpanel"]')!;
		assert.equal(panel.id, tabs()[1]!.getAttribute("aria-controls"));
		assert.equal(panel.getAttribute("aria-labelledby"), tabs()[1]!.id);
		assert.match(host.textContent!, /The aldehyde\./);
		assert.doesNotMatch(host.textContent!, /The alcohol\./);
		await act(async () => button("Copy structure").click());
		assert.deepEqual(copies, ["CC=O"]);
		await act(async () => button("View 3D").click());
		await waitFor(() => !!document.querySelector('[data-testid="step-model"]'), "the selected step should reach the 3D viewer");
		assert.equal(previews.at(-1)!.smiles, "CC=O");
		assert.equal(previews.at(-1)!.steps, undefined);
		await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close molecule view"]')!.click());
		await act(async () => button("Use in answer").click());
		assert.deepEqual(answers, [source], "using a later step keeps every ordered synthesis step");
		await act(async () => root.render(<ChemistryAnswerProvider><MoleculeFigure source={source} /></ChemistryAnswerProvider>));
		await act(async () => button("Edit a copy").click());
		await waitFor(() => editors.length > 0, "editing should open the synthesis editor");
		assert.deepEqual(editors.at(-1)!.initial, source, "editing from a later tab receives the entire sequence");
		assert.equal(JSON.stringify(source), original, "viewing, copying and editing never mutate the saved source");
	} finally {
		await act(async () => root.unmount());
		host.remove();
		hook.deregister();
		delete globals[captureKey];
		delete prototype.showModal;
		delete prototype.close;
	}
});
