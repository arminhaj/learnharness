"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { parseMoleculeDocument, type MoleculeDocument, type MoleculeSource } from "@/src/core";
import { ChemistryDialog } from "./chemistry-dialog";
import { MoleculeFigure } from "./molecule-figure";

const StructureEditor = lazy(() => import("./structure-editor"));
export default function ChemistryWorkbench({ draftKey, initial, value, onChange, disabled = false }: {
	draftKey: string; initial?: MoleculeSource; value?: MoleculeDocument;
	onChange: (doc: MoleculeDocument | undefined) => void; disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [seed, setSeed] = useState<MoleculeSource | MoleculeDocument>();
	const [storageError, setStorageError] = useState(false);
	const [hasDraft, setHasDraft] = useState(false);
	const changeRef = useRef(onChange);
	changeRef.current = onChange;
	const storageKey = `lh:chemistry:${draftKey}`;
	const activeStorageKey = useRef(storageKey);
	activeStorageKey.current = storageKey;
	const lastInitial = useRef(initial);
	const firstLoad = useRef(true);
	const stored = useRef<{ attached?: MoleculeDocument; editing?: MoleculeDocument | null }>({ attached: value });
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
					editing: saved.editing === null ? null : saved.editing ? parseMoleculeDocument(saved.editing) : undefined,
				};
			}
		} catch { setStorageError(true); }
		setHasDraft(stored.current.editing !== undefined);
		setSeed(stored.current.editing ?? stored.current.attached ?? initial);
		changeRef.current(stored.current.attached);
	}, [storageKey]);
	useEffect(() => {
		if (!initial || initial === lastInitial.current) return;
		lastInitial.current = initial;
		setSeed(initial); setOpen(true);
	}, [initial]);
	const remember = (doc: MoleculeDocument | null) => {
		// A closing editor may finish serialization after the next question
		// mounts. Its draft must not overwrite that question's workspace.
		if (activeStorageKey.current !== storageKey) return;
		stored.current.editing = doc; setHasDraft(true); persist();
	};
	return <section aria-label="Structure answer" data-chemistry-interactive="" className="px-2 py-2" onKeyDown={event => event.stopPropagation()}>
		{value && <MoleculeFigure source={value} actions={false} />}
		<div className="flex flex-wrap items-center gap-2">
			<button type="button" disabled={disabled} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50" onClick={() => { setSeed(stored.current.editing === null ? undefined : stored.current.editing ?? value ?? initial); setOpen(true); }}>{hasDraft ? "Resume drawing" : value ? "Edit structure" : "Draw structure"}</button>
			{value && <button type="button" disabled={disabled} className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent" onClick={() => {
				changeRef.current(undefined); stored.current = {}; setHasDraft(false); setSeed(undefined);
				try { localStorage.removeItem(storageKey); } catch { setStorageError(true); }
			}}>Remove structure</button>}
			{value && <span className="text-xs text-muted-foreground">Structure attached to your answer</span>}
		</div>
		{storageError && <p role="status" className="mt-1 text-xs text-muted-foreground">The browser could not save this draft. Keep this page open until you submit.</p>}
		{open && <ChemistryDialog title="Draw your answer" onClose={() => setOpen(false)}><Suspense fallback={<p className="p-6">Loading structure editor…</p>}><StructureEditor initial={seed} onChange={remember} onSave={doc => { const answer = { ...doc, label: "Your structure" }; stored.current = { attached: answer }; persist(); setHasDraft(false); changeRef.current(answer); setOpen(false); }} onCancel={() => { delete stored.current.editing; persist(); setHasDraft(false); setOpen(false); }} /></Suspense></ChemistryDialog>}
	</section>;
}
