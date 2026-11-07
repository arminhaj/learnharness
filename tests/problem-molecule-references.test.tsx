import React, { act } from "react";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { publicChemistryContext, type MoleculeDocument, type MoleculeReference, type MoleculeSource } from "../src/core/index.ts";
import { curvedArrowsDocument } from "./fixtures/curved-arrows.ts";

const fence = (smiles: string, label: string) => `\`\`\`molecule\n${JSON.stringify({ smiles, label })}\n\`\`\``;

test("question and practice reference banks receive only public material scoped to their own problem", async () => {
	const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const storage = new Map<string, string>();
	Object.assign(globalThis, {
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const captureKey = Symbol.for("learnharness.test.problem-references");
	type WorkbenchProps = { draftKey: string; problemReferences: readonly MoleculeReference[]; continuation?: MoleculeDocument; continuationReferenceKeys?: readonly string[] };
	type Capture = { workbench: (props: WorkbenchProps) => void; collect: (markdown: readonly string[], additional?: readonly MoleculeSource[]) => void };
	const globals = globalThis as typeof globalThis & { [captureKey]?: Capture };
	const workbenches = new Map<string, WorkbenchProps>();
	const collections: { markdown: readonly string[]; additional: readonly MoleculeSource[] }[] = [];
	globals[captureKey] = {
		workbench: props => workbenches.set(props.draftKey, props),
		collect: (markdown, additional = []) => collections.push({ markdown, additional }),
	};
	const moduleUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`;
	const workbench = moduleUrl('export default function Workbench(props) { globalThis[Symbol.for("learnharness.test.problem-references")].workbench(props); return globalThis.React.createElement("output", {"data-testid":"reference-bank", "data-key":props.draftKey}); }');
	const prose = moduleUrl('export function ToolContentResponse({children}) { return globalThis.React.createElement("div", null, children); }');
	const coreUrl = new URL("../src/core/index.ts", import.meta.url).href;
	// Keep the real collection/parser implementation. Observe its public input
	// boundary separately so selectable option labels can be checked too.
	const core = moduleUrl(`export * from ${JSON.stringify(coreUrl)}; import {collectMoleculeReferences as collect} from ${JSON.stringify(coreUrl)}; export function collectMoleculeReferences(markdown, additional) { globalThis[Symbol.for("learnharness.test.problem-references")].collect(markdown, additional); return collect(markdown, additional); }`);
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (/\/components\/(?:question-dock|practice-dock)/.test(context.parentURL ?? "")) {
				const url = specifier === "@/components/chemistry/chemistry-workbench" ? workbench
					: specifier === "@/components/ai-elements/message" ? prose
						: specifier === "@/src/core" ? core : undefined;
				if (url) return { url, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	const parentMessages = [{ role: "assistant", parts: [
		{ type: "text", text: fence("CCCl", "Previous problem") },
		{ type: "tool-explain", toolCallId: "old", state: "output-available" },
		{ type: "text", text: fence("CCO", "Public introduction") },
		{ type: "tool-explain", toolCallId: "question", state: "input-available", input: { correctAnswer: fence("CCBr", "Hidden transcript solution") } },
	] }];
	const childMessages = [{ role: "assistant", parts: [
		{ type: "text", text: fence("CCN", "Child introduction") },
		{ type: "tool-explain", toolCallId: "question", state: "input-available" },
	] }];
	const parentContext = publicChemistryContext(parentMessages, "question");
	const childContext = publicChemistryContext(childMessages, "question");
	const question = {
		question: `Draw the next intermediate.\n${fence("C=O", "Question structure")}`,
		details: fence("O", "Public details"),
		correctAnswer: fence("C#N", "Hidden commitment"),
		explanation: fence("N#N", "Hidden explanation"),
		choiceHints: [
			{ label: fence("CBr", "Hidden hint"), value: "hidden-hint" },
			{ label: fence("C#N", "Hidden correct hint"), value: "correct-hint" },
		],
	};
	const practice = {
		statement: `Continue this synthesis.\n${fence("CC=O", "Practice structure")}`,
		chemistry: { startingStructure: "N", instructions: fence("CO", "Public instructions") },
		modelSolution: fence("CF", "Hidden practice solution"),
		decisionPoints: [fence("CCl", "Hidden decision")],
	};
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try {
		const [{ QuestionDock }, { PracticeDock }] = await Promise.all([import("../components/question-dock.tsx"), import("../components/practice-dock.tsx")]);
		await act(async () => root.render(<>
			<QuestionDock draftKey="parent:question" toolName="explain" toolCallId="question" input={question} chemistryContext={parentContext} expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />
			<QuestionDock draftKey="child:question" toolName="explain" toolCallId="question" input={{ question: "Explore the molecule.", correctAnswer: "A hidden commitment." }} chemistryContext={childContext} expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />
			<PracticeDock draftKey="parent:practice" problemCallId="practice" input={practice} chemistryContext={parentContext} expanded onExpand={() => {}} onSubmit={() => {}} paused />
			<PracticeDock draftKey="child:practice" problemCallId="child-practice" input={{ statement: "Explain the structure above." }} chemistryContext={childContext} expanded onExpand={() => {}} onSubmit={() => {}} paused />
		</>));
		const smiles = (key: string) => workbenches.get(key)!.problemReferences.map(reference => reference.source.smiles);
		assert.deepEqual(smiles("question:parent:question"), ["CCO", "C=O", "O"]);
		assert.deepEqual(smiles("question:child:question"), ["CCN"], "a matching tool-call ID in another chat uses only its supplied public context");
		assert.deepEqual(smiles("practice:parent:practice"), ["CCO", "CC=O", "CO", "N"]);
		assert.deepEqual(smiles("practice:child:practice"), ["CCN"], "a public structure above the problem enables its reference workspace");
		assert.doesNotMatch(JSON.stringify([...workbenches.values()]), /Hidden|CCCl|CCBr|C#N|N#N|CBr|CF|CCl/);
		collections.length = 0;
		const options = [
			{ label: fence("CCC", "Visible option A"), value: "a" },
			{ label: fence("CCF", "Visible option B"), value: "b" },
		];
		await act(async () => root.render(<QuestionDock toolName="quiz" toolCallId="options" input={{ question: "Choose the product.", options, correctAnswer: "a", explanation: fence("CCI", "Hidden option explanation") }} expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />));
		assert.ok(collections.some(collection => options.every(option => collection.markdown.includes(option.label))), "displayed choice labels are public reference sources");
		assert.ok(collections.every(collection => !collection.markdown.some(text => text.includes("Hidden option explanation"))));
		const referenceDraftKeys = ["question:parent:previous"];
		await act(async () => root.render(<QuestionDock draftKey="parent:repair" toolName="explain" toolCallId="repair"
			input={{ question: "Repair your previous mechanism.", correctAnswer: "The corrected mechanism." }}
			structureContinuation={{ molecule: curvedArrowsDocument, referenceDraftKeys, problemReferences: [{ id: "original", name: "Original reagent", source: { smiles: "CO" } }] }}
			expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />));
		const continued = workbenches.get("question:parent:repair")!;
		assert.deepEqual(continued.continuation, curvedArrowsDocument);
		assert.deepEqual(continued.continuationReferenceKeys, referenceDraftKeys);
		assert.equal(continued.problemReferences[0]!.name, "Original reagent");
	} finally {
		await act(async () => root.unmount());
		host.remove();
		hook.deregister();
		delete globals[captureKey];
	}
});
