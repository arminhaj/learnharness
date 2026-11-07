import { KetSerializer, MolSerializer, Pile, type EditorSelection, type Struct } from "ketcher-core";
import type { MoleculeSource } from "@/src/core";
import { smilesFromMolfile } from "./indigo-client";

/** Capture one whole connected molecule, with its drawing, without changing selection or canvas. */
export function selectedMoleculeSnapshot(struct: Struct, selection: EditorSelection | null): MoleculeSource {
	const selectedAtoms = new Set((selection?.atoms ?? []).filter(id => struct.atoms.has(id)));
	for (const id of selection?.bonds ?? []) {
		const bond = struct.bonds.get(id);
		if (bond) {
			selectedAtoms.add(bond.begin);
			selectedAtoms.add(bond.end);
		}
	}
	const firstAtom = selectedAtoms.values().next().value;
	if (firstAtom === undefined) throw new Error("Select an atom or bond in one molecule.");

	const neighbors = new Map<number, number[]>();
	for (const bond of struct.bonds.values()) {
		const begin = neighbors.get(bond.begin) ?? [];
		const end = neighbors.get(bond.end) ?? [];
		begin.push(bond.end);
		end.push(bond.begin);
		neighbors.set(bond.begin, begin);
		neighbors.set(bond.end, end);
	}
	const component = new Set<number>([firstAtom]);
	const pending = [firstAtom];
	for (let index = 0; index < pending.length; index++) {
		for (const id of neighbors.get(pending[index]!) ?? []) {
			if (!component.has(id)) {
				component.add(id);
				pending.push(id);
			}
		}
	}
	if ([...selectedAtoms].some(id => !component.has(id))) {
		throw new Error("Select atoms or bonds from only one molecule.");
	}

	// Clone the entire component, preserving atom and bond chemistry. The
	// empty sets exclude shapes, text, attachment marks, images, and arrows.
	const noAnnotations = new Pile<number>();
	const molecule = struct.clone(new Pile(component), undefined, true, undefined,
		noAnnotations, noAnnotations, noAnnotations, noAnnotations, noAnnotations);
	return { version: 1, molfile: new MolSerializer().serialize(molecule), ket: new KetSerializer().serialize(molecule) };
}

/** Derive the chemical source used by 3D, excluding drawing annotations. */
export async function selectedMoleculeSource(struct: Struct, selection: EditorSelection | null): Promise<MoleculeSource> {
	let snapshot: MoleculeSource;
	try { snapshot = selectedMoleculeSnapshot(struct, selection); }
	catch (error) {
		if (error instanceof Error && /^Select (?:an atom or bond in|atoms or bonds from only) one molecule\.$/.test(error.message)) {
			throw new Error(error.message.slice(0, -1) + " to view it in 3D.");
		}
		throw error;
	}
	const molfile = snapshot.molfile!;
	return { version: 1, molfile, smiles: await smilesFromMolfile(molfile) };
}
