"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Editor } from "ketcher-react";
import { StandaloneStructServiceProvider } from "ketcher-standalone";
import type { Ketcher } from "ketcher-core";
import "ketcher-react/dist/index.css";
import { Button } from "@/components/ui/button";
import { moleculeInput, type MoleculeDocument } from "@/src/core";
import type { StructureEditorProps } from "./structure-editor";

const provider = new StandaloneStructServiceProvider();
const hidden = { hidden: true };
// The lesson owns 3D and fullscreen. Unsupported reactions/query objects
// should not masquerade as single-molecule answers.
const buttons = { miew: hidden, recognize: hidden, fullscreen: hidden, "reaction-plus": hidden, arrows: hidden, "reaction-mapping-tools": hidden, "create-monomer": hidden };

export default function KetcherEditor({ initial, onChange, onSave, onCancel }: StructureEditorProps) {
	const initialRef = useRef(initial);
	const editorRef = useRef<Ketcher | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const mounted = useRef(true);
	const unsubscribeRef = useRef<(() => void) | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const revision = useRef(0);
	const dirty = useRef(false);
	const explicitlyClosed = useRef(false);
	const [ready, setReady] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const snapshot = useCallback(async (editor: Ketcher): Promise<MoleculeDocument> => {
		if (editor.containsReaction()) throw new Error("Submit a molecule without reaction arrows.");
		const [molfile, smiles, ket] = await Promise.all([editor.getMolfile("v3000"), editor.getSmiles(), editor.getKet()]);
		if (!smiles.trim()) throw new Error("Draw a structure before saving it.");
		return { version: 1, molfile, smiles, ket, ...(initialRef.current?.label ? { label: initialRef.current.label } : {}) };
	}, []);

	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			revision.current++;
			if (timer.current) clearTimeout(timer.current);
			unsubscribeRef.current?.();
			const editor = editorRef.current;
			// X/Escape preserves the current editing draft, including an edit
			// made inside the debounce interval. Start serialization before
			// Ketcher's child cleanup disposes its drawing. Save/Cancel have
			// already decided what to retain and must never get overwritten.
			if (editor && dirty.current && !explicitlyClosed.current) {
				const changed = onChangeRef.current;
				if (editor.editor.struct().atoms.size === 0) changed?.(null);
				else void snapshot(editor).then(document => changed?.(document)).catch(() => {
					// Preserve the last complete draft if an unfinished object
					// cannot yet be serialized as a molecule.
				});
			}
			editorRef.current = null;
		};
	}, [snapshot]);

	const handleInit = useCallback((editor: Ketcher) => {
		editorRef.current = editor;
		void (async () => {
			try {
				// Molfile carries the authoritative molecular graph and its layout.
				// Do not let stale editor JSON replace a newer structure revision.
				const source = initialRef.current;
				if (source) {
					let structure = moleculeInput(source);
					const sdfOnly = "sdf" in source && !!source.sdf && !source.molfile && !source.smiles;
					if (sdfOnly) {
						// Strip SDF record metadata through the chemistry parser,
						// rather than relying on the editor's format detection.
						const response = await fetch("/api/chemistry/normalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(source) });
						const result = await response.json();
						if (!response.ok) throw new Error(result.error || "Could not import this SDF structure.");
						structure = result.molfile;
					}
					if (!mounted.current || editorRef.current !== editor) return;
					await editor.setMolecule(structure);
					// Imported conformers need a skeletal 2D layout for editing;
					// preserve existing layouts for ordinary 2D Molfile drafts.
					if (sdfOnly || /3D/.test(structure.split(/\r?\n/)[1] ?? "")) await editor.layout();
				}
				if (!mounted.current || editorRef.current !== editor) return;
				setReady(true);
				const changed = () => {
					dirty.current = true;
					const currentRevision = ++revision.current;
					if (timer.current) clearTimeout(timer.current);
					if (editor.editor.struct().atoms.size === 0) {
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
			} catch (e) {
				if (mounted.current) {
					setError(e instanceof Error ? e.message : "Could not load this structure.");
					// Loading a bad initial source should not prevent drawing a
					// corrected replacement in the already initialized editor.
					setReady(true);
				}
			}
		})();
	}, [snapshot]);

	const save = async () => {
		const editor = editorRef.current;
		if (!editor || saving) return;
		setSaving(true);
		setError(null);
		try {
			const draft = await snapshot(editor);
			const response = await fetch("/api/chemistry/normalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || "This structure could not be validated.");
			if (mounted.current) {
				explicitlyClosed.current = true;
				onSave({ ...result, ket: draft.ket });
			}
		} catch (e) {
			if (mounted.current) setError(e instanceof Error ? e.message : "Could not save the structure.");
		} finally {
			if (mounted.current) setSaving(false);
		}
	};

	return (
		<div data-testid="structure-editor" data-chemistry-interactive="" className="space-y-3">
			<div className="relative h-[min(62vh,560px)] min-h-[330px] overflow-hidden rounded-md border bg-white text-black" aria-label="Molecule drawing canvas" aria-busy={!ready}>
				<Editor staticResourcesUrl="/chemistry/ketcher" structServiceProvider={provider} onInit={handleInit} errorHandler={(message) => setError(message)} buttons={buttons} disableMacromoleculesEditor />
			</div>
			{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">Draw bonds and rings, or paste a structure. Your original question stays unchanged.</p>
				<div className="flex gap-2">
					<Button type="button" variant="outline" onClick={() => { explicitlyClosed.current = true; onCancel(); }} disabled={saving}>Cancel</Button>
					<Button type="button" onClick={() => void save()} disabled={!ready || saving}>{saving ? "Checking structure…" : "Use structure"}</Button>
				</div>
			</div>
		</div>
	);
}
