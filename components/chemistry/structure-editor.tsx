"use client";

import dynamic from "next/dynamic";
import type { MoleculeDocument, MoleculeSource, MoleculeReference } from "@/src/core";
import type { StructureEditorDraft, SynthesisEditorDraft } from "./synthesis-draft";

export interface StructureEditorProps {
	initial?: MoleculeSource | MoleculeDocument | SynthesisEditorDraft;
	problemReferences?: MoleculeReference[];
	savedReferences?: MoleculeReference[];
	onReferencesChange?: (references: MoleculeReference[]) => void;
	onChange?: (document: StructureEditorDraft | null) => void;
	onSave: (document: MoleculeDocument) => void;
	onCancel: () => void;
}

// Ketcher and Indigo access browser globals at module initialization. Keep
// their large editor/WASM bundle outside both SSR and the lesson's first load.
const KetcherEditor = dynamic(() => import("./ketcher-editor"), {
	ssr: false,
	loading: () => <p className="p-6 text-sm text-muted-foreground" role="status">Loading structure editor…</p>,
});

export default function StructureEditor(props: StructureEditorProps) {
	return <div data-chemistry-interactive="" className="min-w-0"><KetcherEditor {...props} /></div>;
}
