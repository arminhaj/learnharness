import { moleculeFromEditorDocument } from "../../src/chemistry/editor-document.ts";
import type { MoleculeDocument } from "../../src/core/chemistry.ts";

// Real Ketcher KET syntax, with chemical and arrow coordinates sharing the
// same drawing. Ethanol makes a small, independently normalizable fixture.
const ethanol = {
	type: "molecule",
	atoms: [
		{ label: "C", location: [0, 0, 0] },
		{ label: "C", location: [1, 0, 0] },
		{ label: "O", location: [2, 0, 0] },
	],
	bonds: [{ type: 1, atoms: [0, 1] }, { type: 1, atoms: [1, 2] }],
};
export const ethanolKet = JSON.stringify({ root: { nodes: [{ $ref: "mol0" }] }, mol0: ethanol });
export const curvedArrowsKet = JSON.stringify({
	root: { nodes: [
		{ $ref: "mol0" },
		{ type: "arrow", data: { mode: "elliptical-arc-arrow-open-angle", pos: [{ x: 2, y: 0.3, z: 0 }, { x: 1, y: 0.3, z: 0 }], height: 0.7 } },
		{ type: "arrow", data: { mode: "elliptical-arc-arrow-open-half-angle", pos: [{ x: 0, y: -0.3, z: 0 }, { x: 1, y: -0.3, z: 0 }], height: -0.6 } },
	] },
	mol0: ethanol,
});
export const curvedArrowsDocument: MoleculeDocument = {
	version: 1,
	smiles: "CCO",
	molfile: moleculeFromEditorDocument(curvedArrowsKet),
	ket: curvedArrowsKet,
};
