import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import initRDKit from "@rdkit/rdkit";
import ChemistryWorkbench from "../components/chemistry/chemistry-workbench.tsx";
import type { StructureEditorProps } from "../components/chemistry/structure-editor.tsx";
import { initialSynthesisSteps, parseStructureEditorDraft, type SynthesisEditorDraft } from "../components/chemistry/synthesis-draft.ts";
import { parseMoleculeDocument, type MoleculeDocument } from "../src/core/chemistry.ts";
import { curvedArrowsDocument, curvedArrowsKet } from "./fixtures/curved-arrows.ts";

const engine = await initRDKit();
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

const secondDrawing = JSON.parse(curvedArrowsKet);
secondDrawing.root.nodes[1].data.height = 1.8;
const secondKet = JSON.stringify(secondDrawing);
const emptyKet = JSON.stringify({ root: { nodes: [] } });

function unfinished(): SynthesisEditorDraft {
	return {
		kind: "synthesis-draft", version: 1, activeStepId: "blank", label: "My synthesis",
		steps: [
			{ id: "first", name: "Protonation", source: { ...curvedArrowsDocument }, ket: curvedArrowsKet },
			{ id: "second", name: "Electron transfer", source: { ...curvedArrowsDocument, ket: secondKet }, ket: secondKet },
			{ id: "blank", name: "Next intermediate", ket: emptyKet },
		],
	};
}

function complete(): MoleculeDocument {
	return {
		...curvedArrowsDocument,
		steps: [
			{ ...curvedArrowsDocument, id: "first", name: "Protonation" },
			{ ...curvedArrowsDocument, id: "second", name: "Electron transfer", ket: secondKet },
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

function WorkbenchHarness({ draftKey, continuation }: { draftKey: string; continuation?: MoleculeDocument }) {
	const [value, setValue] = useState<MoleculeDocument>();
	return <>
		<output data-testid="attached" data-document={value ? JSON.stringify(value) : undefined}>{value ? "Attached" : "No attachment"}</output>
		<ChemistryWorkbench draftKey={draftKey} continuation={continuation} value={value} onChange={setValue} />
	</>;
}

async function mount(draftKey: string, continuation?: MoleculeDocument) {
	host = document.createElement("div"); document.body.append(host);
	root = createRoot(host);
	await act(async () => { root!.render(<WorkbenchHarness draftKey={draftKey} continuation={continuation} />); });
	return host;
}

async function captureWorkbenchEditor() {
	const captured: StructureEditorProps[] = [];
	const captureKey = Symbol.for("learnharness.test.synthesis-draft-editor");
	const globals = globalThis as typeof globalThis & { [captureKey]?: (props: StructureEditorProps) => void };
	globals[captureKey] = props => { captured.push(props); };
	const editorUrl = `data:text/javascript,${encodeURIComponent('export default function Editor(props) { globalThis[Symbol.for("learnharness.test.synthesis-draft-editor")](props); return null; }')}`;
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
	const value = container.querySelector('[data-testid="attached"]')!.getAttribute("data-document");
	return value ? JSON.parse(value) as MoleculeDocument : undefined;
};

test("local synthesis drafts preserve blank tabs, active tab, and each step's arrow drawing", () => {
	const draft = unfinished();
	assert.deepEqual(parseStructureEditorDraft(JSON.parse(JSON.stringify(draft))), draft);
	assert.deepEqual(parseStructureEditorDraft(curvedArrowsDocument), curvedArrowsDocument, "legacy unfinished molecular documents remain readable");
	assert.throws(() => parseMoleculeDocument(draft), /SMILES|Molfile/, "an unfinished sequence cannot be treated as a submitted molecule");
	const initialized = initialSynthesisSteps(draft);
	assert.equal(initialized.synthesis, true);
	assert.equal(initialized.activeStepId, "blank");
	assert.equal(initialized.steps[2]!.source, undefined);
	assert.equal(initialized.steps[2]!.ket, emptyKet);
	initialized.steps[0]!.source!.ket = "changed after restoration";
	initialized.steps[1]!.name = "Renamed locally";
	assert.equal(draft.steps[0]!.source!.ket, curvedArrowsKet, "restoring state does not share mutable source objects");
	assert.equal(draft.steps[1]!.name, "Electron transfer");
});

test("draft restoration rejects malformed identity, nested source sequences, and oversized state", () => {
	const draft = unfinished();
	const invalid: unknown[] = [
		{ ...draft, version: 2 },
		{ ...draft, activeStepId: "missing" },
		{ ...draft, steps: [] },
		{ ...draft, steps: Array.from({ length: 13 }, (_, index) => ({ id: `step-${index}`, name: `Step ${index}` })) },
		{ ...draft, steps: [{ id: "bad/id", name: "Step" }] },
		{ ...draft, steps: [{ id: "x", name: "Step" }, { id: "x", name: "Other step" }] },
		{ ...draft, steps: [{ id: "blank", name: " " }] },
		{ ...draft, steps: [{ id: "blank", name: "x".repeat(121) }] },
		{ ...draft, steps: [{ id: "blank", name: "Step", source: complete() }] },
		{ ...draft, steps: [{ id: "blank", name: "Step", source: { smiles: "C".repeat(16_001) } }] },
		{ ...draft, steps: [{ id: "blank", name: "Step", ket: "not JSON" }] },
		{ ...draft, steps: [{ id: "blank", name: "Step", ket: "[]" }] },
		{ ...draft, steps: [{ id: "blank", name: "Step", ket: " ".repeat(500_001) }] },
		{ ...draft, steps: Array.from({ length: 3 }, (_, index) => ({ id: `step-${index}`, name: "Step", ket: JSON.stringify({ note: "x".repeat(400_000) }) })) },
	];
	for (const value of invalid) assert.throws(() => parseStructureEditorDraft(value));
});

test("draft source fields must be valid when present rather than silently discarded", () => {
	const draft = unfinished();
	for (const source of [null, false, 0, ""]) {
		assert.throws(() => parseStructureEditorDraft({ ...draft, steps: [{ id: "blank", name: "Step", source }] }), `invalid source ${JSON.stringify(source)} must be rejected`);
	}
});

test("blank tabs and distinct arrows survive close, reopen, and reload without becoming an attachment", async () => {
	const editor = await captureWorkbenchEditor();
	const draft = unfinished();
	const draftKey = "question:synthesis-lifecycle";
	const storageKey = `lh:chemistry:${draftKey}`;
	try {
		let container = await mount(draftKey);
		const initialEditor = await editor.open(container);
		await act(async () => initialEditor.onChange!(draft));
		assert.deepEqual(JSON.parse(localStorage.getItem(storageKey)!), { editing: draft });
		assert.equal(attachment(container), undefined);
		await editor.close();
		assert.deepEqual((await editor.open(container)).initial, draft);
		await editor.close();
		await act(async () => root!.unmount()); root = undefined;
		container.remove(); host = undefined;
		container = await mount(draftKey);
		assert.equal(attachment(container), undefined, "reloading unfinished tabs never submits them");
		assert.match(container.textContent!, /Resume drawing/);
		assert.doesNotMatch(container.textContent!, /Structure attached to your answer/);
		assert.equal(document.querySelector("dialog"), null, "restoring a draft does not open it automatically");
		assert.deepEqual((await editor.open(container)).initial, draft, "reopening retains active empty tab and both complete arrow drawings");
	} finally { await editor.cleanup(); }
});

test("saving a complete sequence keeps every named step attached separately from later unfinished edits", async () => {
	const editor = await captureWorkbenchEditor();
	const draftKey = "question:synthesis-attachment";
	const storageKey = `lh:chemistry:${draftKey}`;
	const document = complete();
	const answer = { ...document, label: "Your structure" };
	try {
		let container = await mount(draftKey);
		let props = await editor.open(container);
		await act(async () => props.onSave(document));
		assert.deepEqual(attachment(container), answer);
		assert.deepEqual(JSON.parse(localStorage.getItem(storageKey)!), { attached: answer });
		assert.equal(container.querySelectorAll('[role="tab"]').length, 2, "the complete answer renders every step tab");
		props = await editor.open(container);
		assert.deepEqual(props.initial, answer);
		await act(async () => props.onChange!(unfinished()));
		await editor.close();
		assert.deepEqual(attachment(container), answer, "an unfinished extra tab does not replace the saved synthesis");
		await act(async () => root!.unmount()); root = undefined;
		container.remove(); host = undefined;
		container = await mount(draftKey);
		assert.deepEqual(attachment(container), answer, "the full attached synthesis restores after reload");
		assert.deepEqual(JSON.parse(localStorage.getItem(storageKey)!), { attached: answer, editing: unfinished() });
		assert.deepEqual((await editor.open(container)).initial, unfinished(), "resuming restores unfinished work separately from the attached sequence");
	} finally { await editor.cleanup(); }
});

test("stale synthesis draft, save, and cancel callbacks cannot rewrite either question", async () => {
	const editor = await captureWorkbenchEditor();
	try {
		const container = await mount("question:old-synthesis");
		const props = await editor.open(container);
		const lateDraft = props.onChange!;
		await act(async () => lateDraft(unfinished()));
		const oldSaved = localStorage.getItem("lh:chemistry:question:old-synthesis");
		const nextAnswer = { ...complete(), label: "Next question's saved answer" };
		const nextDraft = { ...unfinished(), label: "Next question draft", activeStepId: "first" };
		const nextSaved = JSON.stringify({ attached: nextAnswer, editing: nextDraft });
		localStorage.setItem("lh:chemistry:question:next-synthesis", nextSaved);
		await act(async () => root!.render(<WorkbenchHarness draftKey="question:next-synthesis" />));
		assert.deepEqual(attachment(container), nextAnswer);
		const stale = unfinished(); stale.steps[0]!.name = "Stale mutation";
		for (const [name, callback] of [
			["draft", () => lateDraft(stale)],
			["save", () => props.onSave(complete())],
			["cancel", () => props.onCancel()],
		] as const) {
			await act(async () => callback());
			assert.equal(localStorage.getItem("lh:chemistry:question:next-synthesis"), nextSaved, `old ${name} must preserve the next question's attachment and unfinished work`);
			assert.equal(localStorage.getItem("lh:chemistry:question:old-synthesis"), oldSaved, `old ${name} must not rewrite its earlier saved draft`);
			assert.deepEqual(attachment(container), nextAnswer, `old ${name} must not alter the current answer`);
			assert.match(container.textContent!, /Resume drawing/);
		}
	} finally { await editor.cleanup(); }
});

test("a repair opens a copy of the submitted synthesis, saves under the new question, and leaves the original intact", async () => {
	const editor = await captureWorkbenchEditor();
	const original = complete();
	const originalSaved = JSON.stringify({ attached: original });
	const draftKey = "question:repair-synthesis";
	localStorage.setItem("lh:chemistry:question:original-synthesis", originalSaved);
	try {
		let container = await mount(draftKey, original);
		assert.equal(document.querySelector("dialog"), null, "a follow-up does not interrupt reading with an editor");
		assert.equal(attachment(container), undefined, "a copied starting drawing is not a submitted answer");
		let props = await editor.open(container);
		assert.deepEqual(props.initial, original);
		assert.notEqual(props.initial, original);
		assert.deepEqual(JSON.parse(localStorage.getItem(`lh:chemistry:${draftKey}`)!), { editing: original });
		const revised = unfinished();
		await act(async () => props.onChange!(revised));
		await editor.close();
		await act(async () => root!.unmount()); root = undefined;
		container.remove(); host = undefined;
		container = await mount(draftKey, original);
		props = await editor.open(container);
		assert.deepEqual(props.initial, revised, "the current question's unfinished work wins on reload");
		await act(async () => props.onSave(complete()));
		assert.deepEqual(attachment(container), { ...complete(), label: "Your structure" });
		assert.equal(localStorage.getItem("lh:chemistry:question:original-synthesis"), originalSaved);
		assert.deepEqual(original, complete(), "editing and saving the copy never changes the earlier synthesis");
		const remove = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Remove structure")!;
		await act(async () => remove.click());
		assert.equal((await editor.open(container)).initial, undefined, "removing the current answer must not silently re-copy the earlier one");
		await editor.close();
		await act(async () => root!.unmount()); root = undefined;
		container.remove(); host = undefined;
		container = await mount(draftKey, original);
		assert.equal((await editor.open(container)).initial, undefined, "the deliberate removal also survives reload");
	} finally { await editor.cleanup(); }
});

test("saved attachments and deliberately cleared drafts take precedence over the previous synthesis", async () => {
	const editor = await captureWorkbenchEditor();
	const original = complete();
	const current = { ...complete(), label: "Current answer" };
	try {
		localStorage.setItem("lh:chemistry:question:already-saved", JSON.stringify({ attached: current }));
		const container = await mount("question:already-saved", original);
		assert.deepEqual((await editor.open(container)).initial, current);
		await editor.close();
		localStorage.setItem("lh:chemistry:question:cleared", JSON.stringify({ editing: null }));
		await act(async () => root!.render(<WorkbenchHarness draftKey="question:cleared" continuation={original} />));
		assert.equal(attachment(container), undefined);
		assert.equal((await editor.open(container)).initial, undefined);
		assert.deepEqual(JSON.parse(localStorage.getItem("lh:chemistry:question:cleared")!), { editing: null });
	} finally { await editor.cleanup(); }
});
