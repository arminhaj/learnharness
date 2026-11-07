import assert from "node:assert/strict";
import test from "node:test";
import { KetSerializer, MolSerializer, type EditorSelection } from "ketcher-core";
import { selectedMoleculeSnapshot, selectedMoleculeSource } from "../components/chemistry/selected-molecule.ts";
import { smilesFromMolfile } from "../components/chemistry/indigo-client.ts";
import { normalizeMolecule } from "../src/server/chemistry.ts";
import { curvedArrowsKet } from "./fixtures/curved-arrows.ts";

function twoMolecules() {
	const drawing = JSON.parse(curvedArrowsKet);
	drawing.root.nodes.push({ $ref: "mol1" });
	drawing.root.nodes.push({ type: "text", boundingBox: { x: -2, y: -2, width: 2, height: 1 }, paragraphs: [{ parts: [{ text: "Reaction step" }] }] });
	drawing.mol1 = { type: "molecule", atoms: [{ label: "N", charge: 1, location: [6, 0, 0] }] };
	return new KetSerializer().deserialize(JSON.stringify(drawing));
}

test("a reference snapshot is synchronous and preserves the complete component's original coordinates", () => {
	const struct = twoMolecules();
	const serializer = new KetSerializer();
	const original = serializer.serialize(struct);
	const selection = { bonds: [1], rxnArrows: [0, 1], texts: [0] };
	const snapshot = selectedMoleculeSnapshot(struct, selection);
	assert.equal(snapshot instanceof Promise, false);
	const captured = serializer.deserialize(snapshot.ket!);
	const molfile = new MolSerializer().deserialize(snapshot.molfile!);
	assert.equal(captured.atoms.size, 3);
	assert.equal(captured.bonds.size, 2);
	assert.equal(captured.rxnArrows.size, 0);
	assert.equal(captured.texts.size, 0);
	for (const [id, atom] of captured.atoms) {
		assert.deepEqual(atom.pp, struct.atoms.get(id)!.pp);
		assert.deepEqual(molfile.atoms.get(id)!.pp, atom.pp);
	}
	assert.equal(serializer.serialize(struct), original);
	assert.deepEqual(selection, { bonds: [1], rxnArrows: [0, 1], texts: [0] });
});

test("reference KET retains explicit alternating double bonds and formal charges", () => {
	const benzene = {
		type: "molecule", atoms: Array.from({ length: 6 }, (_, index) => ({ label: "C", location: [Math.cos(index * Math.PI / 3), Math.sin(index * Math.PI / 3), 0] })),
		bonds: Array.from({ length: 6 }, (_, index) => ({ type: index % 2 + 1, atoms: [index, (index + 1) % 6] })),
	};
	const struct = new KetSerializer().deserialize(JSON.stringify({ root: { nodes: [{ $ref: "mol0" }, { $ref: "mol1" }] }, mol0: benzene, mol1: { type: "molecule", atoms: [{ label: "N", charge: 1, location: [6, 0, 0] }] } }));
	const ring = new KetSerializer().deserialize(selectedMoleculeSnapshot(struct, { atoms: [0] }).ket!);
	assert.deepEqual([...ring.bonds.values()].map(bond => bond.type), [1, 2, 1, 2, 1, 2]);
	const ion = new KetSerializer().deserialize(selectedMoleculeSnapshot(struct, { atoms: [6] }).ket!);
	assert.equal(ion.atoms.size, 1);
	assert.equal(ion.atoms.get(0)!.charge, 1);
});

test("partial atom selection expands to its whole molecule and leaves both molecules and arrows unchanged", async () => {
	const struct = twoMolecules();
	const serializer = new KetSerializer();
	const original = serializer.serialize(struct);
	const selection: EditorSelection = { atoms: [1], rxnArrows: [0, 1], texts: [0] };
	const originalSelection = JSON.stringify(selection);
	const source = await selectedMoleculeSource(struct, selection);
	assert.equal(source.smiles, "CCO");
	assert.equal(new MolSerializer().deserialize(source.molfile!).atoms.size, 3);
	assert.equal(source.ket, undefined);
	assert.doesNotMatch(source.molfile!, /arrow|\$RXN/);
	assert.equal(serializer.serialize(struct), original);
	assert.equal(JSON.stringify(selection), originalSelection);
	assert.equal(struct.atoms.size, 4);
	assert.equal(struct.rxnArrows.size, 2);
	assert.equal(struct.texts.size, 1);
});

test("a selected bond identifies the complete molecular component", async () => {
	const source = await selectedMoleculeSource(twoMolecules(), { bonds: [1] });
	assert.equal(source.smiles, "CCO");
	assert.equal(new MolSerializer().deserialize(source.molfile!).bonds.size, 2);
});

test("a selected isolated atom keeps its formal charge and excludes the other molecule", async () => {
	const source = await selectedMoleculeSource(twoMolecules(), { atoms: [3] });
	assert.equal(source.smiles, "[NH4+]");
	const molecule = new MolSerializer().deserialize(source.molfile!);
	assert.equal(molecule.atoms.size, 1);
	assert.equal(molecule.atoms.get(0)?.charge, 1);
});

test("empty or annotation-only selections explain how to choose a molecule", async () => {
	const struct = twoMolecules();
	for (const selection of [null, {}, { rxnArrows: [0, 1] }, { texts: [0] }, { atoms: [999] }]) {
		await assert.rejects(selectedMoleculeSource(struct, selection), /Select an atom or bond in one molecule/);
	}
});

test("selections spanning disconnected molecules are rejected without changing the canvas", async () => {
	const struct = twoMolecules();
	const serializer = new KetSerializer();
	const original = serializer.serialize(struct);
	for (const selection of [{ atoms: [1, 3] }, { bonds: [0], atoms: [3] }]) {
		await assert.rejects(selectedMoleculeSource(struct, selection), /only one molecule/);
	}
	assert.equal(serializer.serialize(struct), original);
});

test("extracting a connected component preserves specified tetrahedral and alkene stereochemistry", async () => {
	for (const input of ["C[C@H](O)CC", "C[C@@H](O)CC", "C/C=C/C"]) {
		const complete = await normalizeMolecule({ smiles: `${input}.N` });
		const expectedMolecule = await normalizeMolecule({ smiles: input });
		const struct = new MolSerializer().deserialize(complete.molfile);
		const serializer = new KetSerializer();
		const original = serializer.serialize(struct);
		const source = await selectedMoleculeSource(struct, { atoms: [0] });
		const reference = selectedMoleculeSnapshot(struct, { atoms: [0] });
		const expected = await smilesFromMolfile(expectedMolecule.molfile);
		assert.equal(source.smiles, expected, input);
		assert.equal(await smilesFromMolfile(reference.molfile!), expected, "reference Molfile retains specified stereochemistry");
		assert.equal(await smilesFromMolfile(new MolSerializer().serialize(serializer.deserialize(reference.ket!))), expected, "reference KET retains specified stereochemistry");
		assert.match(source.smiles!, /@|[\\/]/, input);
		assert.equal(serializer.serialize(struct), original);
	}
});
