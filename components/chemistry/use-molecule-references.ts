"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Ketcher } from "ketcher-core";
import { parseMoleculeReferences, type MoleculeReference, type MoleculeSource } from "@/src/core";
import { selectedMoleculeSnapshot } from "./selected-molecule";

interface SelectionSnapshot {
	token: string;
	source: MoleculeSource;
	revision: number;
	stepId: string;
}

export function useMoleculeReferences({ editorRef, revisionRef, stepRef, ready, disabled, initialReferences = [], onChange }: {
	editorRef: RefObject<Ketcher | null>;
	revisionRef: RefObject<number>;
	stepRef: RefObject<string>;
	ready: boolean;
	disabled: boolean;
	initialReferences?: MoleculeReference[];
	onChange?: (references: MoleculeReference[]) => void;
}) {
	const [references, setReferences] = useState(() => structuredClone(initialReferences));
	const referencesRef = useRef(references);
	const changeRef = useRef(onChange);
	changeRef.current = onChange;
	const disabledRef = useRef(disabled);
	disabledRef.current = disabled;
	const [selected, setSelected] = useState<SelectionSnapshot>();
	const selectedRef = useRef<SelectionSnapshot | undefined>(undefined);

	useEffect(() => {
		let current = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const clear = () => {
			if (timer) clearTimeout(timer);
			selectedRef.current = undefined;
			setSelected(undefined);
		};
		clear();
		const editor = editorRef.current;
		if (!ready || disabled || !editor) return;
		const refresh = () => {
			clear();
			const revision = revisionRef.current;
			const stepId = stepRef.current;
			timer = setTimeout(() => {
				if (!current || disabledRef.current || editorRef.current !== editor || revisionRef.current !== revision || stepRef.current !== stepId) return;
				try {
					const source = selectedMoleculeSnapshot(editor.editor.struct(), editor.editor.selection());
					const snapshot = { token: `selection-${crypto.randomUUID()}`, source, revision, stepId };
					selectedRef.current = snapshot;
					setSelected(snapshot);
				} catch { /* A selection spanning no molecule or several molecules has no drag handle. */ }
			}, 80);
		};
		const selectionChanged = (selection: unknown) => { refresh(); return selection; };
		const selectionEvent = editor.editor.event?.selectionChange;
		editor.changeEvent.add(refresh);
		selectionEvent?.add(selectionChanged);
		refresh();
		return () => {
			current = false;
			if (timer) clearTimeout(timer);
			selectedRef.current = undefined;
			editor.changeEvent.remove(refresh);
			selectionEvent?.remove(selectionChanged);
		};
	}, [editorRef, revisionRef, stepRef, ready, disabled]);

	const selectedSource = useCallback((token?: string): MoleculeSource => {
		const snapshot = selectedRef.current;
		if (disabledRef.current || !snapshot || token !== undefined && token !== snapshot.token
			|| snapshot.revision !== revisionRef.current || snapshot.stepId !== stepRef.current) {
			throw new Error("Select an atom or bond in one molecule, then drag its Selected molecule preview or save it as a reference.");
		}
		return structuredClone(snapshot.source);
	}, [revisionRef, stepRef]);

	const update = useCallback((next: MoleculeReference[]) => {
		const parsed = parseMoleculeReferences(next);
		referencesRef.current = parsed;
		setReferences(parsed);
		changeRef.current?.(structuredClone(parsed));
	}, []);

	const saveSelected = useCallback(async (token?: string) => {
		const source = selectedSource(token);
		let index = referencesRef.current.length + 1;
		while (referencesRef.current.some(reference => reference.name === `Intermediate ${index}`)) index++;
		update([...referencesRef.current, { id: `reference-${crypto.randomUUID()}`, name: `Intermediate ${index}`, source }]);
	}, [selectedSource, update]);

	const rename = useCallback((id: string, name: string) => {
		update(referencesRef.current.map(reference => reference.id === id ? { ...reference, name } : reference));
	}, [update]);

	const remove = useCallback((id: string) => {
		update(referencesRef.current.filter(reference => reference.id !== id));
	}, [update]);

	return { references, selected, selectedSource, saveSelected, rename, remove };
}
