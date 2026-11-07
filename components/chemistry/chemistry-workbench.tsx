"use client";

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { collectMoleculeReferences, parseMoleculeDocument, parseMoleculeReferences, type MoleculeDocument, type MoleculeSource, type MoleculeReference } from "@/src/core";
import { ChemistryDialog } from "./chemistry-dialog";
import { MoleculeFigure } from "./molecule-figure";
import { parseStructureEditorDraft, type StructureEditorDraft } from "./synthesis-draft";

const StructureEditor = lazy(() => import("./structure-editor"));
export default function ChemistryWorkbench({ draftKey, initial, continuation, continuationReferenceKeys = [], value, onChange, problemReferences = [], disabled = false }: {
	draftKey: string; initial?: MoleculeSource; value?: MoleculeDocument;
	/** Previous submitted answer, used only when this question has no work. */
	continuation?: MoleculeDocument;
	/** Earlier workspaces in this synthesis, newest first. */
	continuationReferenceKeys?: readonly string[];
	problemReferences?: MoleculeReference[];
	onChange: (doc: MoleculeDocument | undefined) => void; disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [seed, setSeed] = useState<MoleculeSource | StructureEditorDraft>();
	const [storageError, setStorageError] = useState(false);
	const [hasDraft, setHasDraft] = useState(false);
	const [savedReferences, setSavedReferences] = useState<MoleculeReference[]>([]);
	const availableReferences = useMemo(() => collectMoleculeReferences([], [...problemReferences.map(reference => ({ ...reference.source, label: reference.name })), ...(initial ? [initial] : [])]), [problemReferences, initial]);
	const changeRef = useRef(onChange);
	changeRef.current = onChange;
	const storageKey = `lh:chemistry:${draftKey}`;
	const activeStorageKey = useRef(storageKey);
	activeStorageKey.current = storageKey;
	const lastInitial = useRef(initial);
	const firstLoad = useRef(true);
	const stored = useRef<{ attached?: MoleculeDocument; editing?: StructureEditorDraft | null; references?: MoleculeReference[]; referenceVersion?: 1 }>({ attached: value });
	const referenceState = () => ({ references: stored.current.references, referenceVersion: stored.current.referenceVersion });
	const persist = () => {
		try { localStorage.setItem(storageKey, JSON.stringify(stored.current)); setStorageError(false); }
		catch { setStorageError(true); }
	};
	useEffect(() => {
		stored.current = firstLoad.current ? { attached: value } : {};
		firstLoad.current = false;
		try {
			const raw = localStorage.getItem(storageKey);
			if (raw) {
				const saved = JSON.parse(raw);
				stored.current = {
					attached: saved.attached ? parseMoleculeDocument(saved.attached) : undefined,
					editing: saved.editing === null ? null : saved.editing ? parseStructureEditorDraft(saved.editing) : undefined,
				};
				try {
					if (saved.references !== undefined) stored.current.references = parseMoleculeReferences(saved.references);
					if (saved.referenceVersion === 1) stored.current.referenceVersion = 1;
				}
				catch { setStorageError(true); }
			}
		} catch { setStorageError(true); }
		setHasDraft(stored.current.editing !== undefined);
		setSavedReferences(stored.current.references ?? []);
		setSeed(stored.current.editing ?? stored.current.attached ?? initial);
		changeRef.current(stored.current.attached);
	}, [storageKey]);
	const continuationKeys = JSON.stringify(continuationReferenceKeys);
	useEffect(() => {
		// Older builds persisted an empty bank even when none was chosen.
		// Backfill those workspaces too; versioned empty banks mean an
		// intentional clear and must never resurrect earlier intermediates.
		if (stored.current.referenceVersion === 1 || stored.current.references?.length) return;
		for (const key of JSON.parse(continuationKeys) as string[]) {
			if (key === draftKey) continue;
			try {
				const raw = localStorage.getItem(`lh:chemistry:${key}`);
				if (!raw) continue;
				const saved = JSON.parse(raw);
				if (saved.references === undefined) continue;
				const references = parseMoleculeReferences(saved.references);
				if (!references.length && saved.referenceVersion !== 1) continue;
				stored.current.references = references;
				stored.current.referenceVersion = 1;
				setSavedReferences(references); persist();
				break;
			} catch { setStorageError(true); }
		}
	}, [storageKey, continuationKeys]);
	useEffect(() => {
		if (!initial || initial === lastInitial.current) return;
		lastInitial.current = initial;
		setSeed(initial); setOpen(true);
	}, [initial]);
	const remember = (doc: StructureEditorDraft | null) => {
		// A closing editor may finish serialization after the next question
		// mounts. Its draft must not overwrite that question's workspace.
		if (activeStorageKey.current !== storageKey) return;
		try {
			stored.current.editing = doc === null ? null : parseStructureEditorDraft(doc);
			setHasDraft(true); persist();
		} catch { setStorageError(true); }
	};
	const rememberReferences = (references: MoleculeReference[]) => {
		if (activeStorageKey.current !== storageKey) return;
		try {
			const parsed = parseMoleculeReferences(references);
			stored.current.references = parsed;
			stored.current.referenceVersion = 1;
			setSavedReferences(parsed); persist();
		} catch { setStorageError(true); }
	};
	return <section aria-label="Structure answer" data-chemistry-interactive="" className="px-2 py-2" onKeyDown={event => event.stopPropagation()}>
		{value && <MoleculeFigure source={value} actions={false} />}
		<div className="flex flex-wrap items-center gap-2">
			<button type="button" disabled={disabled} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50" onClick={() => {
				const current = stored.current;
				const source = current.editing === null ? undefined : current.editing ?? current.attached ?? value ?? initial ?? continuation;
				const copy = source ? structuredClone(source) : undefined;
				if (copy && source === continuation) remember(parseMoleculeDocument(copy));
				setSeed(copy); setOpen(true);
			}}>{hasDraft ? "Resume drawing" : value ? "Edit structure" : "Draw structure"}</button>
			{value && <button type="button" disabled={disabled} className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent" onClick={() => {
				changeRef.current(undefined); stored.current = { ...referenceState(), ...(continuation && { editing: null }) }; setHasDraft(false); setSeed(undefined);
				if (continuation || stored.current.referenceVersion || stored.current.references?.length) persist();
				else try { localStorage.removeItem(storageKey); } catch { setStorageError(true); }
			}}>Remove structure</button>}
			{value && <span className="text-xs text-muted-foreground">Structure attached to your answer</span>}
		</div>
		{storageError && <p role="status" className="mt-1 text-xs text-muted-foreground">The browser could not save this draft. Keep this page open until you submit.</p>}
		{open && <ChemistryDialog wide title="Draw your answer" onClose={() => setOpen(false)}><Suspense fallback={<p className="p-6">Loading structure editor…</p>}><StructureEditor key={storageKey} initial={seed} problemReferences={availableReferences} savedReferences={savedReferences} onReferencesChange={rememberReferences} onChange={remember} onSave={doc => { if (activeStorageKey.current !== storageKey) return; const answer = { ...doc, label: "Your structure" }; stored.current = { attached: answer, ...referenceState() }; persist(); setHasDraft(false); changeRef.current(answer); setOpen(false); }} onCancel={() => { if (activeStorageKey.current !== storageKey) return; delete stored.current.editing; persist(); setHasDraft(false); setOpen(false); }} /></Suspense></ChemistryDialog>}
	</section>;
}
