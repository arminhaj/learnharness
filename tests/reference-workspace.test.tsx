import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import initRDKit from "@rdkit/rdkit";
import ChemistryWorkbench from "../components/chemistry/chemistry-workbench.tsx";
import type { StructureEditorProps } from "../components/chemistry/structure-editor.tsx";
import type { SynthesisEditorDraft } from "../components/chemistry/synthesis-draft.ts";
import type { MoleculeDocument, MoleculeReference } from "../src/core";
import { curvedArrowsDocument, curvedArrowsKet } from "./fixtures/curved-arrows.ts";

const engine = await initRDKit();
const amineMolecule = engine.get_mol("CCN")!;
const amine: MoleculeDocument = { version: 1, smiles: amineMolecule.get_smiles(), molfile: amineMolecule.get_molblock() };
amineMolecule.delete();
const dom = parseHTML("<html><head></head><body></body></html>");
const saved = new Map<string, string>();
const localStorage = {
	getItem: (key: string) => saved.get(key) ?? null,
	setItem: (key: string, value: string) => { saved.set(key, String(value)); },
	removeItem: (key: string) => { saved.delete(key); },
	clear: () => saved.clear(),
};
Object.assign(globalThis, {
	React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	localStorage, IS_REACT_ACT_ENVIRONMENT: true,
});
window.initRDKitModule = async () => engine;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

function referenceBank(): MoleculeReference[] {
	return [
		{ id: "intermediate-alcohol", name: "Alcohol intermediate", source: { ...curvedArrowsDocument } },
		{ id: "intermediate-amine", name: "Amine intermediate", source: { ...amine } },
	];
}

function blankDraft(): SynthesisEditorDraft {
	return { kind: "synthesis-draft", version: 1, activeStepId: "empty", steps: [{ id: "empty", name: "Unfinished step", ket: '{"root":{"nodes":[]}}' }] };
}

function completeSynthesis(): MoleculeDocument {
	return {
		...curvedArrowsDocument,
		steps: [
			{ ...curvedArrowsDocument, id: "starting", name: "Starting material" },
			{ ...amine, id: "product", name: "Product" },
		],
	};
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined; host = undefined;
	localStorage.clear();
	document.querySelectorAll("dialog").forEach(dialog => dialog.remove());
});

type HarnessProps = { draftKey: string; problemReferences?: MoleculeReference[]; continuation?: MoleculeDocument; continuationReferenceKeys?: readonly string[] };
function WorkbenchHarness({ draftKey, problemReferences = [], continuation, continuationReferenceKeys }: HarnessProps) {
	const [value, setValue] = useState<MoleculeDocument>();
	return <>
		<output data-testid="attached" data-document={value ? JSON.stringify(value) : undefined}>{value ? "Attached" : "No attachment"}</output>
		<ChemistryWorkbench draftKey={draftKey} value={value} onChange={setValue} problemReferences={problemReferences} continuation={continuation} continuationReferenceKeys={continuationReferenceKeys} />
	</>;
}

async function mount(draftKey: string, problemReferences?: MoleculeReference[], extra: Partial<HarnessProps> = {}) {
	host = document.createElement("div"); document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<WorkbenchHarness draftKey={draftKey} problemReferences={problemReferences} {...extra} />));
	return host;
}

async function captureWorkbenchEditor() {
	const captured: StructureEditorProps[] = [];
	const captureKey = Symbol.for("learnharness.test.reference-workspace-editor");
	const globals = globalThis as typeof globalThis & { [captureKey]?: (props: StructureEditorProps) => void };
	globals[captureKey] = props => captured.push(props);
	const editorUrl = `data:text/javascript,${encodeURIComponent('export default function Editor(props) { globalThis[Symbol.for("learnharness.test.reference-workspace-editor")](props); return null; }')}`;
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (/^\.\/structure-editor(?:\.tsx)?$/.test(specifier) && context.parentURL?.includes("chemistry-workbench")) return { url: editorUrl, shortCircuit: true };
			return nextResolve(specifier, context);
		},
	});
	await import(editorUrl);
	const prototype = dom.window.HTMLElement.prototype as HTMLElement & { showModal?: () => void; close?: () => void };
	prototype.showModal = function () { this.setAttribute("open", ""); };
	prototype.close = function () { this.removeAttribute("open"); };
	return {
		captured,
		async open(container: HTMLElement) {
			const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(candidate => /^(Draw structure|Resume drawing|Edit structure)$/.test(candidate.textContent!));
			assert.ok(button);
			await act(async () => { button.click(); await new Promise(resolve => setImmediate(resolve)); });
			assert.ok(captured.length);
			return captured.at(-1)!;
		},
		async close() {
			await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close molecule view"]')!.click());
			assert.equal(document.querySelector("dialog"), null);
		},
		async cleanup() {
			await act(async () => root?.unmount()); root = undefined;
			hook.deregister();
			delete globals[captureKey];
			delete prototype.showModal;
			delete prototype.close;
		},
	};
}

const attachment = (container: HTMLElement) => {
	const json = container.querySelector('[data-testid="attached"]')!.getAttribute("data-document");
	return json ? JSON.parse(json) as MoleculeDocument : undefined;
};

test("related questions recover legacy reference banks alongside an existing synthesis draft", async () => {
	const editor = await captureWorkbenchEditor();
	const originalKey = "question:lesson:original";
	const currentKey = "question:lesson:repair";
	const original = JSON.stringify({ attached: completeSynthesis(), references: referenceBank() });
	localStorage.setItem(`lh:chemistry:${originalKey}`, original);
	localStorage.setItem(`lh:chemistry:${currentKey}`, JSON.stringify({ editing: blankDraft(), references: [] }));
	const extra = { continuation: completeSynthesis(), continuationReferenceKeys: ["question:lesson:middle", originalKey] };
	try {
		let container = await mount(currentKey, undefined, extra);
		let props = await editor.open(container);
		assert.deepEqual(props.initial, blankDraft(), "the current drawing is never replaced during reference recovery");
		assert.deepEqual(props.savedReferences, referenceBank());
		assert.equal(attachment(container), undefined);
		assert.equal(localStorage.getItem(`lh:chemistry:${originalKey}`), original);
		const changed = referenceBank(); changed[0]!.name = "Revised intermediate";
		await act(async () => props.onReferencesChange!(changed));
		await editor.close();
		await act(async () => root!.unmount()); root = undefined;
		container.remove(); host = undefined;
		container = await mount(currentKey, undefined, extra);
		props = await editor.open(container);
		assert.deepEqual(props.savedReferences, changed, "a follow-up owns its independent saved reference bank after reload");
		assert.equal(localStorage.getItem(`lh:chemistry:${originalKey}`), original);
	} finally { await editor.cleanup(); }
});

test("current references take precedence and deliberately emptied banks stay empty across follow-ups", async () => {
	const editor = await captureWorkbenchEditor();
	const keys = ["question:lesson:middle", "question:lesson:original"];
	localStorage.setItem(`lh:chemistry:${keys[1]}`, JSON.stringify({ references: referenceBank() }));
	localStorage.setItem(`lh:chemistry:${keys[0]}`, JSON.stringify({ references: [], referenceVersion: 1 }));
	const extra = { continuation: completeSynthesis(), continuationReferenceKeys: keys };
	try {
		const container = await mount("question:lesson:next", undefined, extra);
		let props = await editor.open(container);
		assert.deepEqual(props.savedReferences, [], "an intentional clear on the preceding question stops older-bank fallback");
		await act(async () => props.onReferencesChange!(referenceBank()));
		await editor.close();
		props = await editor.open(container);
		assert.deepEqual(props.savedReferences, referenceBank());
		await act(async () => props.onReferencesChange!([]));
		await editor.close();
		localStorage.setItem(`lh:chemistry:${keys[0]}`, JSON.stringify({ references: referenceBank(), referenceVersion: 1 }));
		await act(async () => root!.unmount()); root = undefined;
		container.remove(); host = undefined;
		const reloaded = await mount("question:lesson:next", undefined, extra);
		assert.deepEqual((await editor.open(reloaded)).savedReferences, [], "reloading must not resurrect references removed from this question");
	} finally { await editor.cleanup(); }
});

test("existing nonempty banks win, and malformed ancestor banks do not block valid earlier references", async () => {
	const editor = await captureWorkbenchEditor();
	const keys = ["question:lesson:malformed", "question:lesson:original"];
	localStorage.setItem(`lh:chemistry:${keys[0]}`, JSON.stringify({ references: [{ id: "bad/id" }] }));
	localStorage.setItem(`lh:chemistry:${keys[1]}`, JSON.stringify({ references: referenceBank() }));
	localStorage.setItem("lh:chemistry:question:lesson:existing", JSON.stringify({ references: [referenceBank()[1]] }));
	const extra = { continuation: completeSynthesis(), continuationReferenceKeys: keys };
	try {
		const container = await mount("question:lesson:existing", undefined, extra);
		assert.deepEqual((await editor.open(container)).savedReferences, [referenceBank()[1]]);
		await editor.close();
		await act(async () => root!.render(<WorkbenchHarness draftKey="question:lesson:new" {...extra} />));
		assert.deepEqual((await editor.open(container)).savedReferences, referenceBank());
	} finally { await editor.cleanup(); }
});

test("a reference bank survives a blank draft's close, reopen, and reload without attaching an answer", async () => {
	const editor = await captureWorkbenchEditor();
	const draftKey = "question:reference-blank";
	const storageKey = `lh:chemistry:${draftKey}`;
	const bank = referenceBank();
	try {
		let container = await mount(draftKey);
		let props = await editor.open(container);
		assert.deepEqual(props.savedReferences, []);
		await act(async () => { props.onReferencesChange!(bank); props.onChange!(blankDraft()); });
		assert.equal(attachment(container), undefined);
		assert.deepEqual(JSON.parse(localStorage.getItem(storageKey)!), { references: bank, referenceVersion: 1, editing: blankDraft() });
		await editor.close();
		props = await editor.open(container);
		assert.deepEqual(props.savedReferences, bank);
		assert.deepEqual(props.initial, blankDraft());
		await editor.close();
		await act(async () => root!.unmount()); root = undefined;
		container.remove(); host = undefined;
		container = await mount(draftKey);
		assert.equal(attachment(container), undefined);
		assert.doesNotMatch(container.textContent!, /Structure attached to your answer/);
		props = await editor.open(container);
		assert.deepEqual(props.savedReferences, bank);
		assert.equal(props.savedReferences[0]!.source.ket, curvedArrowsKet, "an intermediate's editable arrow drawing survives reload");
		assert.deepEqual(props.initial, blankDraft());
	} finally { await editor.cleanup(); }
});

test("saving a synthesis, cancelling later edits, and removing the attachment all keep the reference bank separate", async () => {
	const editor = await captureWorkbenchEditor();
	const draftKey = "question:reference-answer";
	const storageKey = `lh:chemistry:${draftKey}`;
	const bank = referenceBank();
	const answer = { ...completeSynthesis(), label: "Your structure" };
	try {
		let container = await mount(draftKey);
		let props = await editor.open(container);
		await act(async () => props.onReferencesChange!(bank));
		await act(async () => props.onSave(completeSynthesis()));
		assert.deepEqual(attachment(container), answer);
		assert.deepEqual(JSON.parse(localStorage.getItem(storageKey)!), { attached: answer, references: bank, referenceVersion: 1 });
		assert.equal("references" in attachment(container)!, false, "reference cards are workspace aids, not submitted answer fields");
		assert.equal(attachment(container)!.steps!.length, 2);
		await act(async () => root!.unmount()); root = undefined;
		container.remove(); host = undefined;
		container = await mount(draftKey);
		assert.deepEqual(attachment(container), answer, "the complete synthesis restores independently of its reference bank");
		props = await editor.open(container);
		assert.deepEqual(props.savedReferences, bank);
		await act(async () => props.onChange!(blankDraft()));
		await act(async () => props.onCancel());
		assert.deepEqual(attachment(container), answer, "Cancel discards only unfinished editing");
		assert.deepEqual(JSON.parse(localStorage.getItem(storageKey)!), { attached: answer, references: bank, referenceVersion: 1 });
		const remove = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Remove structure")!;
		await act(async () => remove.click());
		assert.equal(attachment(container), undefined);
		assert.deepEqual(JSON.parse(localStorage.getItem(storageKey)!), { references: bank, referenceVersion: 1 });
		assert.deepEqual((await editor.open(container)).savedReferences, bank, "removing an answer does not discard captured intermediates");
	} finally { await editor.cleanup(); }
});

test("provided problem structures are available in the editor without becoming saved reference cards or answers", async () => {
	const editor = await captureWorkbenchEditor();
	const problemReferences = [{ id: "problem-start", name: "Given starting material", source: { ...curvedArrowsDocument } }];
	try {
		const container = await mount("question:given-structures", problemReferences);
		const props = await editor.open(container);
		assert.equal(props.problemReferences?.length, 1);
		assert.equal(props.problemReferences[0]!.name, "Given starting material");
		assert.equal(props.problemReferences[0]!.source.ket, curvedArrowsKet);
		assert.deepEqual(props.savedReferences, []);
		assert.equal(localStorage.getItem("lh:chemistry:question:given-structures"), null);
		assert.equal(attachment(container), undefined);
	} finally { await editor.cleanup(); }
});

test("reference banks are scoped to the problem key and stale reference callbacks cannot alter either bank", async () => {
	const editor = await captureWorkbenchEditor();
	const oldKey = "lh:chemistry:question:old-reference-workspace";
	const nextKey = "lh:chemistry:question:next-reference-workspace";
	const nextBank = [{ id: "next-intermediate", name: "Next problem intermediate", source: { ...amine } }];
	const nextAnswer = { ...amine, label: "Next problem answer" };
	const nextSaved = JSON.stringify({ attached: nextAnswer, references: nextBank });
	localStorage.setItem(nextKey, nextSaved);
	try {
		const container = await mount("question:old-reference-workspace");
		const props = await editor.open(container);
		await act(async () => props.onReferencesChange!(referenceBank()));
		const oldSaved = localStorage.getItem(oldKey);
		await act(async () => root!.render(<WorkbenchHarness draftKey="question:next-reference-workspace" />));
		const stale = referenceBank(); stale[0]!.name = "Stale callback mutation";
		await act(async () => props.onReferencesChange!(stale));
		assert.equal(localStorage.getItem(oldKey), oldSaved);
		assert.equal(localStorage.getItem(nextKey), nextSaved);
		assert.deepEqual(attachment(container), nextAnswer);
		assert.deepEqual(editor.captured.at(-1)!.savedReferences, nextBank);
	} finally { await editor.cleanup(); }
});

test("a malformed stored reference bank never discards a valid attached synthesis", async () => {
	const editor = await captureWorkbenchEditor();
	const answer = { ...completeSynthesis(), label: "Your structure" };
	localStorage.setItem("lh:chemistry:question:malformed-reference-bank", JSON.stringify({ attached: answer, references: [{ id: "bad/id", name: "Invalid reference", source: { smiles: "CCO" } }] }));
	try {
		const container = await mount("question:malformed-reference-bank");
		assert.deepEqual(attachment(container), answer);
		assert.match(container.textContent!, /Structure attached to your answer/);
		assert.deepEqual((await editor.open(container)).savedReferences, []);
	} finally { await editor.cleanup(); }
});

test("an invalid reference callback preserves the last valid bank and attached answer", async () => {
	const editor = await captureWorkbenchEditor();
	const storageKey = "lh:chemistry:question:invalid-reference-callback";
	const answer = { ...amine, label: "Your structure" };
	const bank = referenceBank();
	localStorage.setItem(storageKey, JSON.stringify({ attached: answer, references: bank }));
	try {
		const container = await mount("question:invalid-reference-callback");
		const props = await editor.open(container);
		const before = localStorage.getItem(storageKey);
		await act(async () => props.onReferencesChange!([{ ...bank[0]!, id: "unsafe/id" }]));
		assert.equal(localStorage.getItem(storageKey), before);
		assert.deepEqual(attachment(container), answer);
		assert.deepEqual(editor.captured.at(-1)!.savedReferences, bank);
	} finally { await editor.cleanup(); }
});
