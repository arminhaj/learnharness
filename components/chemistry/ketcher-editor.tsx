"use client";

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { Editor } from "ketcher-react";
import { StandaloneStructServiceProvider } from "ketcher-standalone";
import { CoordinateTransformation, type Ketcher } from "ketcher-core";
import "ketcher-react/dist/index.css";
import { Button } from "@/components/ui/button";
import { MAX_CHEMISTRY_REQUEST_BYTES, MAX_SYNTHESIS_STEPS, moleculeInput, parseMoleculeSource, type MoleculeDocument, type MoleculeSource, type MoleculeStepDocument } from "@/src/core";
import type { StructureEditorProps } from "./structure-editor";
import { snapshotDrawing } from "./editor-snapshot";
import { selectedMoleculeSource } from "./selected-molecule";
import { ChemicalNameSearch, type ChemicalSearchResult } from "./chemical-name-search";
import { insertChemicalStructure } from "./insert-structure";
import { initialSynthesisSteps, type StructureEditorDraft, type SynthesisDraftStep, type SynthesisEditorDraft } from "./synthesis-draft";
import { EditorShortcuts } from "./editor-shortcuts";
import { MOLECULE_DRAG_MIME, MoleculeReferenceSidebar, SelectedMoleculeDrag, readMoleculeDrag } from "./molecule-reference-sidebar";
import { useMoleculeReferences } from "./use-molecule-references";
import { readStructureClipboard } from "./molecule-clipboard";
import { bindKetcherWindow } from "./ketcher-window";
import { editorErrorMessage, withEditorCleanup } from "./editor-cleanup";

const Molecule3D = lazy(() => import("./molecule-3d"));

const provider = withEditorCleanup(new StandaloneStructServiceProvider());
const hidden = { hidden: true };
// Electron-flow arcs annotate the drawing; reaction schemes remain unsupported.
const reactionTools = [
	"open-angle", "filled-triangle", "filled-bow", "dashed-open-angle", "failed", "retrosynthetic",
	"both-ends-filled-triangle", "equilibrium-filled-half-bow", "equilibrium-filled-triangle", "equilibrium-open-angle",
	"unbalanced-equilibrium-filled-half-bow", "unbalanced-equilibrium-open-half-angle",
	"unbalanced-equilibrium-large-filled-half-bow", "unbalanced-equilibrium-filled-half-triangle", "multitail",
	"elliptical-arc-arrow-filled-bow", "elliptical-arc-arrow-filled-triangle",
];
const buttons = {
	miew: hidden, recognize: hidden, fullscreen: hidden, "reaction-plus": hidden,
	"reaction-mapping-tools": hidden, "create-monomer": hidden,
	...Object.fromEntries(reactionTools.map(tool => [`reaction-arrow-${tool}`, hidden])),
};

export default function KetcherEditor({ initial, onChange, onSave, onCancel, problemReferences = [], savedReferences = [], onReferencesChange }: StructureEditorProps) {
	const initialRef = useRef(initial);
	const initialSteps = useRef(initialSynthesisSteps(initial));
	const [steps, setSteps] = useState(initialSteps.current.steps);
	const stepsRef = useRef(steps);
	const [activeStepId, setActiveStepId] = useState(initialSteps.current.activeStepId);
	const activeStepRef = useRef(activeStepId);
	const keyboardStepSwitch = useRef(false);
	const synthesis = useRef(initialSteps.current.synthesis);
	const [switching, setSwitching] = useState(false);
	const transitionPending = useRef(false);
	const transitionDraft = useRef<Promise<SynthesisEditorDraft> | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [stepName, setStepName] = useState("");
	const [removedStep, setRemovedStep] = useState<{ step: SynthesisDraftStep; index: number } | null>(null);
	useEffect(() => {
		if (!switching && keyboardStepSwitch.current) {
			keyboardStepSwitch.current = false;
			document.getElementById(`synthesis-tab-${activeStepId}`)?.focus();
		}
	}, [switching, activeStepId]);
	const editorRef = useRef<Ketcher | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const mounted = useRef(true);
	const unsubscribeRef = useRef<(() => void) | null>(null);
	const releaseWindowRef = useRef<(() => void) | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const revision = useRef(0);
	const dirty = useRef(false);
	const explicitlyClosed = useRef(false);
	const [ready, setReady] = useState(false);
	const [saving, setSaving] = useState(false);
	const [inserting, setInserting] = useState(false);
	const insertionPending = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const previewButtonRef = useRef<HTMLButtonElement>(null);
	const previewSequence = useRef(0);
	const [preparingPreview, setPreparingPreview] = useState(false);
	const [previewSource, setPreviewSource] = useState<MoleculeSource | null>(null);
	const previewOpen = useRef(false);
	previewOpen.current = previewSource !== null;
	const [pasteOpen, setPasteOpen] = useState(false);
	const [pasteText, setPasteText] = useState("");
	const [pasteNotice, setPasteNotice] = useState<string>();
	const [readingClipboard, setReadingClipboard] = useState(false);
	const referenceDisabled = !ready || saving || inserting || switching || preparingPreview || !!previewSource;
	const references = useMoleculeReferences({ editorRef, revisionRef: revision, stepRef: activeStepRef, ready, disabled: referenceDisabled, initialReferences: savedReferences, onChange: onReferencesChange });

	const closePreview = useCallback(() => {
		previewSequence.current++;
		setPreviewSource(null);
		previewButtonRef.current?.focus();
	}, []);

	useEffect(() => {
		const dialog = rootRef.current?.closest("dialog");
		if (!dialog) return;
		// Escape in the sandboxed WebGL frame may cancel the parent dialog
		// without a keydown reaching React. Return to the drawing first.
		const cancelPreview = (event: Event) => {
			if (!previewOpen.current) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			closePreview();
		};
		dialog.addEventListener("cancel", cancelPreview, true);
		return () => dialog.removeEventListener("cancel", cancelPreview, true);
	}, [closePreview]);

	const draftFromSteps = useCallback((draftSteps: SynthesisDraftStep[], activeId: string): SynthesisEditorDraft => ({
		kind: "synthesis-draft", version: 1, activeStepId: activeId,
		steps: structuredClone(draftSteps), ...(initialRef.current?.label && { label: initialRef.current.label }),
	}), []);

	const snapshot = useCallback(async (editor: Ketcher): Promise<StructureEditorDraft | null> => {
		if (transitionPending.current) return transitionDraft.current ?? draftFromSteps(stepsRef.current, activeStepRef.current);
		const empty = !synthesis.current && editor.editor.struct().atoms.size === 0;
		const activeId = activeStepRef.current;
		const draftSteps = structuredClone(stepsRef.current);
		const ket = await editor.getKet();
		const active = draftSteps.find(step => step.id === activeId)!;
		active.ket = ket;
		delete active.source;
		if (synthesis.current) return draftFromSteps(draftSteps, activeId);
		if (empty) return null;
		return snapshotDrawing(ket, initialRef.current?.label);
	}, [draftFromSteps]);

	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			previewSequence.current++;
			revision.current++;
			if (timer.current) clearTimeout(timer.current);
			unsubscribeRef.current?.();
			const editor = editorRef.current;
			const releaseWindow = releaseWindowRef.current;
			releaseWindowRef.current = null;
			// X/Escape preserves the current editing draft, including an edit
			// made inside the debounce interval. Start serialization before
			// Ketcher's child cleanup disposes its drawing. Save/Cancel have
			// already decided what to retain and must never get overwritten.
			if (editor && dirty.current && !explicitlyClosed.current) {
				const changed = onChangeRef.current;
				void snapshot(editor).then(document => changed?.(document)).catch(() => {
					// Preserve the last complete draft if an unfinished object
					// cannot yet be serialized as a molecule.
				}).finally(() => releaseWindow?.());
			} else releaseWindow?.();
			editorRef.current = null;
		};
	}, [snapshot]);

	const loadStep = useCallback(async (editor: Ketcher, step: SynthesisDraftStep, firstLoad = false) => {
		if (step.ket !== undefined) {
			await editor.setMolecule(step.ket);
		} else if (step.source) {
			const source = step.source;
			let structure = moleculeInput(source);
			const sdfOnly = !!source.sdf && !source.molfile && !source.smiles;
			if (sdfOnly || source.ket) {
				const response = await fetch("/api/chemistry/normalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(source) });
				const result = await response.json();
				if (!response.ok) throw new Error(result.error || "Could not load this structure.");
				structure = result.ket ?? result.molfile;
			}
			if (!mounted.current || editorRef.current !== editor) return;
			await editor.setMolecule(structure);
			if (sdfOnly || /3D/.test(structure.split(/\r?\n/)[1] ?? "")) await editor.layout();
		} else if (!firstLoad) {
			editor.editor.clear();
		}
		// Undo must never cross into another synthesis step.
		if (!firstLoad) {
			editor.editor.selection(null);
			editor.editor.clearHistory();
		}
	}, []);

	const handleInit = useCallback((editor: Ketcher) => {
		// Vendor initialization can finish after the dialog has unmounted.
		if (!mounted.current) return;
		releaseWindowRef.current?.();
		releaseWindowRef.current = bindKetcherWindow(editor);
		editorRef.current = editor;
		void (async () => {
			try {
				await loadStep(editor, stepsRef.current.find(step => step.id === activeStepRef.current)!, true);
			} catch (e) {
				if (mounted.current) {
					setError(e instanceof Error ? e.message : "Could not load this structure.");
					// Loading a bad initial source should not prevent drawing a
					// corrected replacement in the already initialized editor.
				}
			}
			if (!mounted.current || editorRef.current !== editor) return;
			setReady(true);
			const changed = () => {
				if (transitionPending.current) return;
				dirty.current = true;
				if (previewOpen.current) closePreview();
				const currentRevision = ++revision.current;
				if (timer.current) clearTimeout(timer.current);
				if (!synthesis.current && editor.editor.struct().atoms.size === 0) {
					onChangeRef.current?.(null);
					return;
				}
				timer.current = setTimeout(() => {
					void snapshot(editor).then((document) => {
						if (mounted.current && currentRevision === revision.current) onChangeRef.current?.(document);
					}).catch(() => { /* Incomplete edits remain in the editor; Save explains validation failures. */ });
				}, 350);
			};
			editor.changeEvent.add(changed);
			unsubscribeRef.current?.();
			unsubscribeRef.current = () => editor.changeEvent.remove(changed);
		})();
	}, [snapshot, closePreview, loadStep]);

	const changeSteps = async (change: (current: SynthesisDraftStep[]) => { steps: SynthesisDraftStep[]; activeId: string; removed?: { step: SynthesisDraftStep; index: number } | null }) => {
		const editor = editorRef.current;
		if (!editor || !ready || saving || insertionPending.current || preparingPreview || transitionPending.current) return;
		transitionPending.current = true;
		setSwitching(true);
		setError(null);
		setRenaming(false);
		if (previewOpen.current) closePreview();
		++revision.current;
		if (timer.current) clearTimeout(timer.current);
		const previousId = activeStepRef.current;
		try {
			const previousSteps = structuredClone(stepsRef.current);
			transitionDraft.current = editor.getKet().then(ket => draftFromSteps(previousSteps.map(step => step.id === previousId ? { id: step.id, name: step.name, ket } : step), previousId));
			const capturedDraft = await transitionDraft.current;
			if (!mounted.current) return;
			const captured = capturedDraft.steps;
			stepsRef.current = captured;
			const next = change(captured);
			if (next.steps.length < 1 || next.steps.length > MAX_SYNTHESIS_STEPS) throw new Error(`Use at most ${MAX_SYNTHESIS_STEPS} synthesis steps.`);
			const target = next.steps.find(step => step.id === next.activeId);
			if (!target) throw new Error("Choose a synthesis step to open.");
			synthesis.current = true;
			stepsRef.current = next.steps;
			activeStepRef.current = next.activeId;
			transitionDraft.current = Promise.resolve(draftFromSteps(next.steps, next.activeId));
			setSteps(next.steps);
			setActiveStepId(next.activeId);
			dirty.current = true;
			if (next.activeId !== previousId) {
				try { await loadStep(editor, target); }
				catch (reason) {
					const previous = captured.find(step => step.id === previousId)!;
					stepsRef.current = captured; activeStepRef.current = previousId;
					transitionDraft.current = Promise.resolve(draftFromSteps(captured, previousId));
					if (mounted.current) { setSteps(captured); setActiveStepId(previousId); await loadStep(editor, previous); }
					throw reason;
				}
			}
			if (mounted.current) {
				if ("removed" in next) setRemovedStep(next.removed ?? null);
				onChangeRef.current?.(draftFromSteps(stepsRef.current, activeStepRef.current));
			}
		} catch (reason) {
			if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not change synthesis steps.");
		} finally {
			transitionPending.current = false;
			transitionDraft.current = null;
			if (mounted.current) setSwitching(false);
		}
	};

	const selectStep = (id: string) => {
		if (id !== activeStepRef.current) void changeSteps(current => ({ steps: current, activeId: id }));
	};

	const showPreview = async () => {
		const editor = editorRef.current;
		if (!editor || !ready || saving || preparingPreview || insertionPending.current || transitionPending.current) return;
		const request = ++previewSequence.current;
		const drawingRevision = revision.current;
		setPreparingPreview(true);
		setError(null);
		try {
			const source = await selectedMoleculeSource(editor.editor.struct(), editor.editor.selection());
			if (!mounted.current || request !== previewSequence.current) return;
			if (drawingRevision !== revision.current) throw new Error("Your drawing changed while preparing the preview. Select the molecule and try again.");
			setPreviewSource({ ...source, label: "Selected molecule" });
		} catch (e) {
			if (mounted.current && request === previewSequence.current) setError(e instanceof Error ? e.message : "Could not preview the selected molecule.");
		} finally {
			if (mounted.current && request === previewSequence.current) setPreparingPreview(false);
		}
	};

	const insertStructure = async (structure: string | MoleculeSource, point?: { clientX: number; clientY: number }) => {
		const editor = editorRef.current;
		if (!editor || !ready || saving || preparingPreview || previewOpen.current || insertionPending.current || transitionPending.current) {
			throw new Error("Return to the drawing and wait for the editor before inserting a structure.");
		}
		if (typeof structure === "string" && (!structure.trim() || new TextEncoder().encode(structure).length > MAX_CHEMISTRY_REQUEST_BYTES)) throw new Error("Paste one molecular structure of at most 1 MB.");
		const modelPoint = point ? CoordinateTransformation.pageToModel(point, editor.editor.render) : undefined;
		const drawingRevision = revision.current;
		insertionPending.current = true;
		setInserting(true);
		setError(null);
		try {
			let input: string;
			if (typeof structure === "string") input = structure;
			else {
				const source = parseMoleculeSource(structure);
				if (source.steps) throw new Error("Paste one molecule into the current synthesis step at a time.");
				input = moleculeInput(source);
				if (source.ket) {
					const response = await fetch("/api/chemistry/normalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(source) });
					const result = await response.json();
					if (!response.ok) throw new Error(result.error || "This reference structure could not be validated.");
					input = result.ket ?? result.molfile;
				}
			}
			await insertChemicalStructure(editor, input, () => mounted.current && editorRef.current === editor && revision.current === drawingRevision, modelPoint ? { modelX: modelPoint.x, modelY: modelPoint.y } : undefined);
		} finally {
			insertionPending.current = false;
			if (mounted.current) setInserting(false);
		}
	};
	const insertChemical = (chemical: ChemicalSearchResult) => insertStructure(chemical.smiles);
	const insertReference = (source: MoleculeSource, point?: { clientX: number; clientY: number }) => {
		const parsed = parseMoleculeSource(source);
		if (parsed.steps) return Promise.reject(new Error("Paste one molecule into the current synthesis step at a time."));
		return insertStructure(parsed, point);
	};
	const insertPastedText = async (text: string) => {
		if (new TextEncoder().encode(text).length > MAX_CHEMISTRY_REQUEST_BYTES) throw new Error("Paste one molecular structure of at most 1 MB.");
		let structure = text.trim();
		if (structure.startsWith("{")) {
			try {
				const value: unknown = JSON.parse(structure);
				if (value && typeof value === "object" && ("smiles" in value || "molfile" in value || "sdf" in value)) {
					await insertReference(parseMoleculeSource(value));
					setPasteOpen(false); setPasteNotice(undefined); return;
				}
			} catch (reason) {
				if (reason instanceof Error && !(reason instanceof SyntaxError)) throw reason;
			}
		}
		await insertStructure(structure);
		if (mounted.current) { setPasteOpen(false); setPasteNotice(undefined); }
	};
	const pasteClipboard = async () => {
		if (referenceDisabled || readingClipboard) return;
		const stepId = activeStepRef.current;
		const drawingRevision = revision.current;
		setReadingClipboard(true); setError(null);
		try {
			let text: string;
			try { text = await readStructureClipboard(); }
			catch {
				if (mounted.current) { setPasteNotice("Paste your Molfile, SMILES, or KET below, then choose Insert pasted structure."); setPasteOpen(true); }
				return;
			}
			if (!mounted.current) return;
			if (stepId !== activeStepRef.current || drawingRevision !== revision.current) throw new Error("The drawing changed while reading the clipboard. Paste again into the current step.");
			setPasteText(text);
			await insertPastedText(text);
		} catch (reason) {
			if (mounted.current) { setError(reason instanceof Error ? reason.message : "Could not paste this structure."); setPasteOpen(true); }
		} finally { if (mounted.current) setReadingClipboard(false); }
	};
	const dropIntoDrawing = (event: DragEvent<HTMLDivElement>) => {
		if (!Array.from(event.dataTransfer.types).includes(MOLECULE_DRAG_MIME)) return;
		event.preventDefault(); event.stopPropagation();
		if (referenceDisabled || insertionPending.current || transitionPending.current) return;
		const payload = readMoleculeDrag(event.dataTransfer);
		if (!payload) return;
		try {
			const source = payload.type === "selection" ? references.selectedSource(payload.token)
				: [...references.references, ...problemReferences].find(reference => reference.id === payload.id)?.source;
			if (!source) throw new Error("This reference is no longer available. Choose another reference molecule.");
			void insertReference(source, { clientX: event.clientX, clientY: event.clientY }).catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not drop this molecule."); });
		} catch (reason) { setError(reason instanceof Error ? reason.message : "Could not drop this molecule."); }
	};

	const save = async () => {
		const editor = editorRef.current;
		if (!editor || saving || insertionPending.current || transitionPending.current) return;
		setSaving(true);
		setError(null);
		try {
			const savedRevision = revision.current;
			const activeKet = await editor.getKet();
			const captured = stepsRef.current.map(step => step.id === activeStepRef.current ? { id: step.id, name: step.name, ket: activeKet } : step);
			const documents: MoleculeStepDocument[] = [];
			for (const step of captured) {
				try {
					let document: MoleculeDocument;
					if (step.ket !== undefined) document = await snapshotDrawing(step.ket, step.source?.label ?? initialRef.current?.label);
					else if (step.source) {
						const response = await fetch("/api/chemistry/normalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(step.source) });
						const result = await response.json();
						if (!response.ok) throw new Error(result.error || "Could not validate this step.");
						document = result;
					} else throw new Error("Draw a structure or remove the empty step before saving.");
					documents.push({ ...document, id: step.id, name: step.name });
				} catch (reason) {
					throw new Error(`${synthesis.current ? `${step.name}: ` : ""}${reason instanceof Error ? reason.message : "Could not save this step."}`);
				}
			}
			const { id: _id, name: _name, ...firstDocument } = documents[0]!;
			const draft: MoleculeDocument = { ...firstDocument, ...(synthesis.current && { steps: documents }) };
			const response = await fetch("/api/chemistry/normalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || "This structure could not be validated.");
			if (mounted.current) {
				if (savedRevision !== revision.current) throw new Error("Your drawing changed while saving. Use structure again to save the latest drawing.");
				explicitlyClosed.current = true;
					onSave(result);
			}
		} catch (e) {
			if (mounted.current) setError(e instanceof Error ? e.message : "Could not save the structure.");
		} finally {
			if (mounted.current) setSaving(false);
		}
	};

	return (
		<div ref={rootRef} data-testid="structure-editor" data-chemistry-interactive="" className="space-y-3" onKeyDownCapture={event => {
			if (event.key === "Escape" && previewOpen.current) { event.preventDefault(); event.stopPropagation(); closePreview(); }
		}}>
			<div className="space-y-2" aria-label="Synthesis workspace">
				<div className="flex flex-wrap items-center gap-2">
					<div role="tablist" aria-label="Synthesis steps" className="flex flex-1 gap-1 overflow-x-auto">
						{steps.map((step, index) => <button type="button" role="tab" key={step.id} id={`synthesis-tab-${step.id}`} aria-selected={step.id === activeStepId} aria-controls="synthesis-drawing-panel" tabIndex={step.id === activeStepId ? 0 : -1} disabled={!ready || saving || inserting || switching || preparingPreview} className={`shrink-0 rounded-md border px-3 py-1.5 text-sm ${step.id === activeStepId ? "border-primary bg-accent font-medium" : "border-transparent text-muted-foreground hover:bg-accent"}`} onClick={() => selectStep(step.id)} onKeyDown={event => {
							const target = event.key === "ArrowRight" ? (index + 1) % steps.length : event.key === "ArrowLeft" ? (index - 1 + steps.length) % steps.length : event.key === "Home" ? 0 : event.key === "End" ? steps.length - 1 : -1;
							if (target >= 0) { event.preventDefault(); event.stopPropagation(); if (steps[target]!.id !== activeStepRef.current) { keyboardStepSwitch.current = true; selectStep(steps[target]!.id); } }
						}}>{step.name}</button>)}
					</div>
					<Button type="button" variant="outline" size="sm" disabled={!ready || saving || inserting || switching || preparingPreview || steps.length >= MAX_SYNTHESIS_STEPS} onClick={() => void changeSteps(current => { const id = `step-${crypto.randomUUID()}`; return { steps: [...current, { id, name: `Step ${current.length + 1}` }], activeId: id }; })}>Add step</Button>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button type="button" variant="ghost" size="sm" disabled={!ready || saving || inserting || switching || preparingPreview || steps.length >= MAX_SYNTHESIS_STEPS} onClick={() => void changeSteps(current => { const active = current.find(step => step.id === activeStepRef.current)!; const id = `step-${crypto.randomUUID()}`; const index = current.indexOf(active); const copy = { ...structuredClone(active), id, name: `${active.name.slice(0, 113)} (copy)` }; return { steps: [...current.slice(0, index + 1), copy, ...current.slice(index + 1)], activeId: id }; })}>Duplicate step</Button>
					<Button type="button" variant="ghost" size="sm" disabled={!ready || saving || inserting || switching || preparingPreview} onClick={() => { setStepName(steps.find(step => step.id === activeStepId)!.name); setRenaming(value => !value); }}>Rename step</Button>
					<Button type="button" variant="ghost" size="sm" disabled={!ready || saving || inserting || switching || preparingPreview || steps.length === 1} onClick={() => void changeSteps(current => { const index = current.findIndex(step => step.id === activeStepRef.current); const removed = { step: structuredClone(current[index]!), index }; const remaining = current.filter((_, i) => i !== index); return { steps: remaining, activeId: remaining[Math.min(index, remaining.length - 1)]!.id, removed }; })}>Remove step</Button>
					<EditorShortcuts rootRef={rootRef} disabled={!ready || saving || inserting || switching || preparingPreview || !!previewSource} />
				</div>
				{renaming && <form className="flex gap-2" onKeyDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); event.stopPropagation(); const name = stepName.trim(); if (name) void changeSteps(current => ({ steps: current.map(step => step.id === activeStepRef.current ? { ...step, name } : step), activeId: activeStepRef.current })); }}><input aria-label="Step name" className="min-w-0 flex-1 rounded-md border bg-transparent px-3 py-1 text-sm" value={stepName} maxLength={120} autoFocus onInput={event => setStepName(event.currentTarget.value)} /><Button type="submit" size="sm" disabled={!stepName.trim()}>Save name</Button></form>}
				{removedStep && <p role="status" className="text-xs text-muted-foreground">Removed {removedStep.step.name}. <button type="button" className="underline" disabled={switching || saving || inserting || steps.length >= MAX_SYNTHESIS_STEPS} onClick={() => void changeSteps(current => { const restored = [...current]; restored.splice(removedStep.index, 0, removedStep.step); return { steps: restored, activeId: removedStep.step.id, removed: null }; })}>Undo removal</button></p>}
				{switching && <p role="status" className="text-xs text-muted-foreground">Opening synthesis step…</p>}
			</div>
			{!previewSource && <ChemicalNameSearch key={activeStepId} disabled={!ready || saving || preparingPreview || inserting || switching} onInsert={insertChemical} />}
			<div className="flex flex-wrap items-center gap-2">
				<Button ref={previewButtonRef} type="button" variant="outline" size="sm" disabled={!ready || saving || preparingPreview || inserting || switching} onClick={() => previewSource ? closePreview() : void showPreview()}>{previewSource ? "Back to drawing" : preparingPreview ? "Preparing preview…" : "View selected molecule in 3D"}</Button>
				{!previewSource && <><Button type="button" variant="outline" size="sm" disabled={referenceDisabled || readingClipboard} onClick={() => void pasteClipboard()}>{readingClipboard ? "Reading clipboard…" : "Paste"}</Button><p className="text-xs text-muted-foreground">Select an atom or bond for 3D, copying, or saving an intermediate.</p></>}
			</div>
			{pasteOpen && !previewSource && <form className="space-y-2 rounded-md border p-3" onKeyDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); event.stopPropagation(); void insertPastedText(pasteText).catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not paste this structure."); }); }}>
				{pasteNotice && <p className="text-xs text-muted-foreground">{pasteNotice}</p>}
				<textarea aria-label="Paste molecular structure" className="h-24 w-full rounded border bg-transparent p-2 font-mono text-xs" value={pasteText} onChange={event => setPasteText(event.target.value)} disabled={referenceDisabled} />
				<div className="flex gap-2"><Button type="submit" size="sm" disabled={referenceDisabled || !pasteText.trim()}>Insert pasted structure</Button><Button type="button" variant="ghost" size="sm" disabled={inserting} onClick={() => setPasteOpen(false)}>Close paste</Button></div>
			</form>}
			<div hidden={!!previewSource} className="flex min-w-0 flex-col items-stretch gap-3 lg:flex-row">
				<div className="min-w-0 flex-1 space-y-2">
					<div className="flex min-h-24 items-center">
						{references.selected ? <SelectedMoleculeDrag selected={references.selected} disabled={referenceDisabled} /> : <p className="text-xs text-muted-foreground">Select an atom or bond in one molecule to copy it or drag its preview to My intermediates.</p>}
					</div>
					<div id="synthesis-drawing-panel" role="tabpanel" aria-labelledby={`synthesis-tab-${activeStepId}`} hidden={!!previewSource} className="relative h-[min(55vh,520px)] min-h-[330px] overflow-hidden rounded-md border bg-white text-black" aria-label="Molecule drawing canvas" aria-busy={!ready || saving || preparingPreview || inserting || switching} inert={saving || preparingPreview || inserting || switching || !!previewSource}
						onDragOver={event => { if (!referenceDisabled && Array.from(event.dataTransfer.types).includes(MOLECULE_DRAG_MIME)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={dropIntoDrawing}>
						<Editor staticResourcesUrl="/chemistry/ketcher" structServiceProvider={provider} onInit={handleInit} errorHandler={(reason: unknown) => { if (mounted.current) setError(editorErrorMessage(reason)); }} buttons={buttons} disableMacromoleculesEditor />
					</div>
				</div>
				<MoleculeReferenceSidebar problemReferences={problemReferences} savedReferences={references.references} selected={references.selected} disabled={referenceDisabled} onInsert={insertReference} onSaveSelected={() => references.saveSelected()} onReferenceDrop={token => references.saveSelected(token)} onRenameReference={references.rename} onRemoveReference={references.remove} />
			</div>
			{previewSource && <div data-testid="editor-3d-preview"><Suspense fallback={<p role="status" className="p-6 text-sm text-muted-foreground">Loading 3D viewer…</p>}><Molecule3D source={previewSource} /></Suspense></div>}
			{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">Draw bonds, rings, and curved arrows, or paste a structure. Your original question stays unchanged.</p>
				<div className="flex gap-2">
					<Button type="button" variant="outline" onClick={() => { explicitlyClosed.current = true; onCancel(); }} disabled={saving || inserting || switching}>Cancel</Button>
					<Button type="button" onClick={() => void save()} disabled={!ready || saving || inserting || switching}>{saving ? "Checking structure…" : synthesis.current ? "Use synthesis" : "Use structure"}</Button>
				</div>
			</div>
		</div>
	);
}
