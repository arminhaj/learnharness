import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import initRDKit from "@rdkit/rdkit";
import ChemistryWorkbench from "../components/chemistry/chemistry-workbench.tsx";
import type { StructureEditorProps } from "../components/chemistry/structure-editor.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { useEnterSubmits } from "../components/enter-submits.ts";
import type { MoleculeDocument, MoleculeSource, QuestionAnswerData, QuizToolInput } from "../src/core";

// Use the real depiction engine, initialized in Node before installing the DOM.
// These tests inspect interaction and state; pixel geometry belongs to browser QA.
const engine = await initRDKit();
function documentFor(smiles: string): MoleculeDocument {
	const molecule = engine.get_mol(smiles)!;
	try { return { version: 1, smiles: molecule.get_smiles(), molfile: molecule.get_molblock() }; }
	finally { molecule.delete(); }
}
const alcohol = documentFor("CCO");
const amine = documentFor("CCN");
const dom = parseHTML("<html><head></head><body></body></html>");
const saved = new Map<string, string>();
const localStorage = {
	getItem: (key: string) => saved.get(key) ?? null,
	setItem: (key: string, value: string) => { saved.set(key, String(value)); },
	removeItem: (key: string) => { saved.delete(key); },
	clear: () => saved.clear(),
};
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	localStorage, IS_REACT_ACT_ENVIRONMENT: true,
});
window.initRDKitModule = async () => engine;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined; host = undefined;
	localStorage.clear();
	document.querySelectorAll("dialog").forEach(dialog => dialog.remove());
});

async function mount(children: React.ReactNode) {
	host = document.createElement("div"); document.body.append(host);
	root = createRoot(host);
	await act(async () => { root!.render(children); });
	return host;
}

function WorkbenchHarness({ draftKey, initial }: { draftKey: string; initial?: MoleculeSource }) {
	const [value, setValue] = useState<MoleculeDocument>();
	return <>
		<output data-testid="attached" data-smiles={value?.smiles}>{value?.smiles ?? "No attachment"}</output>
		<ChemistryWorkbench draftKey={draftKey} initial={initial} value={value} onChange={setValue} />
	</>;
}

test("reloading an unfinished drawing never promotes it to a submitted attachment", async () => {
	const storageKey = "lh:chemistry:question:chat-a:question-a";
	localStorage.setItem(storageKey, JSON.stringify({ editing: alcohol }));
	for (let reload = 0; reload < 2; reload++) {
		const container = await mount(<WorkbenchHarness draftKey="question:chat-a:question-a" />);
		assert.equal(container.querySelector('[data-testid="attached"]')!.getAttribute("data-smiles"), null);
		assert.match(container.textContent!, /Resume drawing/);
		assert.doesNotMatch(container.textContent!, /Structure attached to your answer/);
		assert.equal(document.querySelector("dialog"), null, "restoring a draft does not interrupt the question");
		assert.equal(JSON.parse(localStorage.getItem(storageKey)!).editing.smiles, alcohol.smiles);
		await act(async () => root!.unmount()); root = undefined;
		container.remove(); host = undefined;
	}
});

test("restores the attached structure separately from unsaved edits and the author's starting molecule", async () => {
	const storageKey = "lh:chemistry:practice:chat-a:problem-a";
	localStorage.setItem(storageKey, JSON.stringify({ attached: alcohol, editing: amine }));
	const container = await mount(<WorkbenchHarness draftKey="practice:chat-a:problem-a" initial={{ smiles: "c1ccccc1" }} />);
	assert.equal(container.querySelector('[data-testid="attached"]')!.getAttribute("data-smiles"), alcohol.smiles);
	assert.match(container.textContent!, /Resume drawing/);
	assert.match(container.textContent!, /Structure attached to your answer/);
	assert.equal(document.querySelector("dialog"), null);
	assert.equal(JSON.parse(localStorage.getItem(storageKey)!).editing.smiles, amine.smiles);
});

test("changing the question draft key clears the previous attachment and editing state", async () => {
	localStorage.setItem("lh:chemistry:question:old", JSON.stringify({ attached: alcohol, editing: amine }));
	const container = await mount(<WorkbenchHarness draftKey="question:old" />);
	assert.equal(container.querySelector('[data-testid="attached"]')!.getAttribute("data-smiles"), alcohol.smiles);
	await act(async () => root!.render(<WorkbenchHarness draftKey="question:new" />));
	assert.equal(container.querySelector('[data-testid="attached"]')!.getAttribute("data-smiles"), null);
	assert.match(container.textContent!, /Draw structure/);
	assert.doesNotMatch(container.textContent!, /Resume drawing|Structure attached/);
	assert.equal(JSON.parse(localStorage.getItem("lh:chemistry:question:old")!).attached.smiles, alcohol.smiles, "switching questions never erases another question's work");
});

test("a late editor snapshot from the previous question cannot overwrite the next draft", async () => {
	const captured: StructureEditorProps[] = [];
	const captureKey = Symbol.for("learnharness.test.capture-editor");
	const globals = globalThis as typeof globalThis & { [captureKey]?: (props: StructureEditorProps) => void };
	globals[captureKey] = props => { captured.push(props); };
	// Substitute only the lazy editor boundary; Workbench state, callbacks,
	// persistence, dialog, and question-key transitions remain real.
	const editorUrl = `data:text/javascript,${encodeURIComponent('export default function Editor(props) { globalThis[Symbol.for("learnharness.test.capture-editor")](props); return null; }')}`;
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (/^\.\/structure-editor(?:\.tsx)?$/.test(specifier) && context.parentURL?.includes("chemistry-workbench")) {
				return { url: editorUrl, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	const prototype = dom.window.HTMLElement.prototype as HTMLElement & { showModal?: () => void; close?: () => void };
	prototype.showModal = function () { this.setAttribute("open", ""); };
	prototype.close = function () { this.removeAttribute("open"); };
	try {
		const container = await mount(<WorkbenchHarness draftKey="question:old-editor" />);
		await act(async () => {
			container.querySelector<HTMLButtonElement>("button")!.click();
			await new Promise(resolve => setImmediate(resolve));
		});
		assert.ok(captured.length, "the editor received its real Workbench callbacks");
		const oldSnapshot = captured.at(-1)!.onChange!;
		await act(async () => oldSnapshot(alcohol));
		const oldSaved = localStorage.getItem("lh:chemistry:question:old-editor");
		assert.equal(JSON.parse(oldSaved!).editing.smiles, alcohol.smiles);
		await act(async () => root!.render(<WorkbenchHarness draftKey="question:next-editor" />));
		await act(async () => oldSnapshot(amine));
		assert.equal(localStorage.getItem("lh:chemistry:question:next-editor"), null);
		assert.equal(localStorage.getItem("lh:chemistry:question:old-editor"), oldSaved, "the stale callback does not rewrite either question's saved state");
		assert.equal(container.querySelector('[data-testid="attached"]')!.getAttribute("data-smiles"), null);
		assert.match(container.textContent!, /Draw structure/);
		assert.doesNotMatch(container.textContent!, /Resume drawing|Structure attached/);
	} finally {
		await act(async () => root?.unmount()); root = undefined;
		hook.deregister();
		delete globals[captureKey];
		delete prototype.showModal;
		delete prototype.close;
	}
});

test("an empty unfinished canvas remains distinct from removing the saved attachment", async () => {
	const storageKey = "lh:chemistry:practice:empty-edit";
	localStorage.setItem(storageKey, JSON.stringify({ attached: alcohol, editing: null }));
	const container = await mount(<WorkbenchHarness draftKey="practice:empty-edit" />);
	assert.equal(container.querySelector('[data-testid="attached"]')!.getAttribute("data-smiles"), alcohol.smiles);
	assert.match(container.textContent!, /Resume drawing/);
	assert.equal(JSON.parse(localStorage.getItem(storageKey)!).editing, null);
	const remove = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Remove structure")!;
	await act(async () => remove.click());
	assert.equal(container.querySelector('[data-testid="attached"]')!.getAttribute("data-smiles"), null);
	assert.equal(localStorage.getItem(storageKey), null);
	assert.doesNotMatch(container.textContent!, /Resume drawing/);
});

const molecularQuiz = {
	question: "Select the alcohol.",
	options: [
		{ value: "alcohol", label: '```molecule\n{"smiles":"CCO","label":"Structure A"}\n```' },
		{ value: "amine", label: '```smiles\nCCN\n```' },
	],
	correctAnswer: "alcohol", explanation: "An alcohol contains a hydroxyl group.",
} as QuizToolInput;

test("a restored structure-only answer passes the preview's dictation submission guard", async () => {
	localStorage.setItem("lh:chemistry:question:structure-only", JSON.stringify({ attached: alcohol }));
	const submitted: QuestionAnswerData[] = [];
	const container = await mount(<QuestionDock toolName="explain" toolCallId="structure-only" input={{ question: "Draw ethanol.", correctAnswer: "CCO", explanation: "Ethanol is an alcohol." }} expanded onExpand={() => {}} onSubmit={answer => submitted.push(answer)} dictationClaim={false} />);
	assert.equal(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, false);
	await act(async () => {
		container.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	});
	assert.equal(submitted.length, 1);
	assert.equal(submitted[0]!.molecule?.molfile, alcohol.molfile);
	assert.ok(!submitted[0]!.text?.trim());
});

test("chemistry practice submits its structure independently of the checked-code slot", async () => {
	localStorage.setItem("lh:chemistry:practice:chemistry-practice", JSON.stringify({ attached: alcohol }));
	const submitted: { text: string; codeRunId?: string; molecule?: MoleculeDocument }[] = [];
	const container = await mount(<PracticeDock draftKey="chemistry-practice" problemCallId="draw-alcohol" input={{ statement: "Draw ethanol.", chemistry: {} }} expanded onExpand={() => {}} onSubmit={(text, codeRunId, molecule) => { submitted.push({ text, codeRunId, molecule }); }} />);
	const submit = container.querySelector<HTMLButtonElement>('[data-testid="practice-send"]')!;
	assert.equal(submit.disabled, false);
	await act(async () => submit.click());
	assert.equal(submitted.length, 1);
	assert.equal(submitted[0]!.text, "");
	assert.equal(submitted[0]!.codeRunId, undefined);
	assert.equal(submitted[0]!.molecule?.molfile, alcohol.molfile);
});

test("molecular quiz options have selection controls beside their figures and viewer actions", () => {
	const markup = renderToStaticMarkup(<QuestionDock toolName="quiz" toolCallId="molecular-quiz" input={molecularQuiz} expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />);
	const parsed = parseHTML(`<html><body>${markup}</body></html>`).document;
	const options = parsed.querySelectorAll('[data-testid="molecular-option"]');
	assert.equal(options.length, 2);
	for (const option of options) {
		const select = option.querySelector('button[role="radio"]')!;
		const figure = option.querySelector('[data-testid="molecule-figure"]')!;
		assert.ok(select && figure);
		assert.equal(select.contains(figure), false, "molecular content is not inside the option button");
		assert.equal(select.querySelector("button"), null);
		assert.ok(figure.querySelector('[data-chemistry-interactive] button'), "viewer actions remain available beside selection");
	}
	assert.equal(parsed.querySelector("button button"), null);
});

test("alternate Markdown fences keep molecular option actions outside selection buttons", () => {
	for (const fence of ["~~~", "~~~~", "````"]) {
		const input = { ...molecularQuiz, options: [{ value: "alcohol", label: `${fence}molecule\n{"smiles":"CCO"}\n${fence}` }, { value: "none", label: "None of these" }] };
		const markup = renderToStaticMarkup(<QuestionDock toolName="quiz" toolCallId={`fence-${fence}`} input={input} expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />);
		const parsed = parseHTML(`<html><body>${markup}</body></html>`).document;
		const option = parsed.querySelector('[data-testid="molecular-option"]');
		assert.ok(option, `${fence} is recognized as molecular content`);
		assert.ok(option.querySelector('[data-testid="molecule-figure"]'));
		assert.equal(option.querySelector('button[role="radio"] [data-testid="molecule-figure"]'), null);
		assert.equal(parsed.querySelector("button button"), null);
	}
});

function keyboard(target: HTMLElement | Document, key: string) {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false });
	target.dispatchEvent(event);
	return event;
}

test("molecule toolbar keys never navigate choices or submit an answer", async () => {
	let submissions = 0;
	const container = await mount(<QuestionDock toolName="quiz" toolCallId="keyboard-molecules" input={molecularQuiz} expanded onExpand={() => {}} onSubmit={() => submissions++} dictationClaim={false} />);
	const selection = container.querySelector<HTMLButtonElement>('[role="radio"]')!;
	await act(async () => selection.click());
	const toolbarButton = container.querySelector<HTMLButtonElement>('[data-chemistry-interactive] button')!;
	assert.equal(toolbarButton.disabled, false, "the actual RDKit depiction finished");
	for (const key of ["Tab", "ArrowDown", "ArrowRight", " ", "Enter"]) {
		await act(async () => {
			assert.equal(keyboard(toolbarButton, key).defaultPrevented, false, `${key} remains available to the chemistry control`);
		});
	}
	assert.equal(submissions, 0);
	assert.equal(selection.getAttribute("aria-checked"), "true");
	assert.equal(container.querySelectorAll('[role="radio"][aria-checked="true"]').length, 1);
});

test("an open chemistry dialog suspends question navigation even for keys outside its viewport", async () => {
	let submissions = 0;
	const container = await mount(<QuestionDock toolName="quiz" toolCallId="dialog-molecules" input={molecularQuiz} expanded onExpand={() => {}} onSubmit={() => submissions++} dictationClaim={false} />);
	const selection = container.querySelector<HTMLButtonElement>('[role="radio"]')!;
	await act(async () => selection.click());
	const dialog = document.createElement("dialog");
	dialog.setAttribute("data-chemistry-dialog", ""); dialog.setAttribute("open", "");
	document.body.append(dialog);
	for (const key of ["Tab", "ArrowDown", "ArrowRight", " ", "Enter"]) {
		await act(async () => { assert.equal(keyboard(document.body, key).defaultPrevented, false); });
	}
	assert.equal(submissions, 0);
	assert.equal(selection.getAttribute("aria-checked"), "true");
	dialog.remove();
	await act(async () => { assert.equal(keyboard(document.body, "ArrowDown").defaultPrevented, true, "normal question navigation resumes after the dialog closes"); });
});

test("global Enter-submit yields to chemistry surfaces and open dialogs", async () => {
	let submissions = 0;
	function Harness() {
		useEnterSubmits(() => submissions++);
		return <div data-chemistry-interactive=""><div data-testid="viewport" /></div>;
	}
	const container = await mount(<Harness />);
	const viewport = container.querySelector<HTMLElement>('[data-testid="viewport"]')!;
	await act(async () => { keyboard(viewport, "Enter"); });
	assert.equal(submissions, 0);
	const dialog = document.createElement("dialog");
	dialog.setAttribute("data-chemistry-dialog", ""); dialog.setAttribute("open", ""); document.body.append(dialog);
	await act(async () => { keyboard(document.body, "Enter"); });
	assert.equal(submissions, 0);
	dialog.remove();
	await act(async () => { keyboard(document.body, "Enter"); });
	assert.equal(submissions, 1, "the global submission hook remains active outside chemistry");
});
