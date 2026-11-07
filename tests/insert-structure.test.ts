import assert from "node:assert/strict";
import test from "node:test";
import { Atom, Image, KetSerializer, MolSerializer, MultitailArrow, ReStruct, Struct, Vec2, type Action, type EditorSelection, type Ketcher } from "ketcher-core";
import { insertChemicalStructure } from "../components/chemistry/insert-structure.ts";
import { selectedMoleculeSnapshot } from "../components/chemistry/selected-molecule.ts";
import { smilesFromMolfile } from "../components/chemistry/indigo-client.ts";
import { MAX_MOLECULE_ATOMS } from "../src/core/chemistry.ts";
import { normalizeMolecule } from "../src/server/chemistry.ts";
import { curvedArrowsKet, ethanolKet } from "./fixtures/curved-arrows.ts";

const serializer = new KetSerializer();

function editorHarness(drawing: Struct, convert: () => Promise<{ struct: string }> = async () => ({ struct: ethanolKet })) {
	// Use the real Ketcher render model and paste/undo operations. Only its SVG
	// surface is inert: these tests inspect chemical state rather than drawing pixels.
	const path = { attr() { return this; }, toFront() { return this; } };
	const render = {
		paper: { rect: () => path }, options: { zoom: 1, microModeScale: 40 },
		viewBox: { minX: 0, minY: 0, width: 800, height: 600 },
		clientArea: { getBoundingClientRect: () => ({ left: 100, top: 50 }) },
	} as unknown as Ketcher["editor"]["render"];
	const ctab = new ReStruct(drawing, render);
	render.ctab = ctab;
	const history: Action[] = [];
	let selection: EditorSelection | null = null;
	let changes = 0;
	const editor = {
		structService: { convert, layout: convert },
		editor: {
			struct: () => drawing,
			options: () => ({}),
			render,
			update(action: Action, ignoreHistory = false) {
				assert.equal(ignoreHistory, false, "insertion must be recorded in undo history");
				history.push(action);
				changes++;
			},
			selection(value: EditorSelection) { selection = value; },
		},
	} as unknown as Ketcher;
	return { editor, ctab, history, get selection() { return selection; }, get changes() { return changes; } };
}

test("chemical insertion preserves atoms and curved arrows and undoes as one edit", async () => {
	const drawing = serializer.deserialize(curvedArrowsKet);
	// An annotation farther right than the molecule must also affect placement.
	drawing.rxnArrows.get(0)!.pos = [new Vec2(8, 0.3), new Vec2(10, 0.3)];
	const before = serializer.serialize(drawing);
	const atomsBefore = [...drawing.atoms.entries()].map(([id, atom]) => ({ id, atom, x: atom.pp.x, y: atom.pp.y }));
	const arrowsBefore = [...drawing.rxnArrows.entries()].map(([id, arrow]) => ({ id, arrow, data: JSON.stringify(arrow) }));
	const harness = editorHarness(drawing);
	await insertChemicalStructure(harness.editor, "CCO", () => true);
	assert.equal(drawing.atoms.size, 6);
	assert.equal(drawing.bonds.size, 4);
	assert.equal(harness.history.length, 1);
	assert.equal(harness.changes, 1);
	for (const { id, atom, x, y } of atomsBefore) {
		assert.equal(drawing.atoms.get(id), atom, "existing atom instances stay in place");
		assert.deepEqual([atom.pp.x, atom.pp.y], [x, y]);
	}
	for (const { id, arrow, data } of arrowsBefore) {
		assert.equal(drawing.rxnArrows.get(id), arrow);
		assert.equal(JSON.stringify(arrow), data, "arrow endpoints, mode, and curvature stay unchanged");
	}
	const added = new Set(harness.selection!.atoms);
	assert.equal(added.size, 3);
	assert.equal(Math.min(...[...added].map(id => drawing.atoms.get(id)!.pp.x)), 12.7);
	assert.ok([...drawing.bonds.values()].every(bond => added.has(bond.begin) === added.has(bond.end)), "no bond connects the inserted molecule to the original");
	harness.history[0]!.perform(harness.ctab);
	assert.equal(serializer.serialize(drawing), before, "the inverse Ketcher action restores the entire drawing");
});

test("a chemical can be added to a truly empty canvas and undone", async () => {
	const drawing = new Struct();
	const before = serializer.serialize(drawing);
	const harness = editorHarness(drawing);
	await insertChemicalStructure(harness.editor, "CCO", () => true);
	assert.equal(drawing.atoms.size, 3);
	assert.equal(drawing.bonds.size, 2);
	assert.ok([...drawing.atoms.values()].every(atom => Number.isFinite(atom.pp.x) && Number.isFinite(atom.pp.y)));
	assert.equal(harness.history.length, 1);
	harness.history[0]!.perform(harness.ctab);
	assert.equal(serializer.serialize(drawing), before);
});

test("insertion stays to the right of annotations omitted by Ketcher's structural bounds", async () => {
	const drawing = serializer.deserialize(curvedArrowsKet);
	drawing.images.add(new Image("data:image/png;base64,", new Vec2(15, 0), new Vec2(2, 1)));
	drawing.addMultitailArrow(MultitailArrow.fromTwoPoints(new Vec2(18, -1), new Vec2(23, 1)));
	const before = serializer.serialize(drawing);
	const rightmostAnnotation = Math.max(17, ...[...drawing.multitailArrows.values()].flatMap(arrow => arrow.getReferencePositionsArray().map(point => point.x)));
	const harness = editorHarness(drawing);
	await insertChemicalStructure(harness.editor, "CCO", () => true);
	assert.equal(Math.min(...harness.selection!.atoms!.map(id => drawing.atoms.get(id)!.pp.x)), rightmostAnnotation + 2);
	harness.history[0]!.perform(harness.ctab);
	assert.equal(serializer.serialize(drawing), before);
});

test("a cancelled asynchronous insertion leaves the drawing and history untouched", async () => {
	const drawing = serializer.deserialize(curvedArrowsKet);
	const before = serializer.serialize(drawing);
	let finish!: (value: { struct: string }) => void;
	const harness = editorHarness(drawing, () => new Promise(resolve => { finish = resolve; }));
	let current = true;
	const inserting = insertChemicalStructure(harness.editor, "CCO", () => current);
	current = false;
	finish({ struct: ethanolKet });
	await assert.rejects(inserting, /drawing changed or insertion was cancelled/i);
	assert.equal(serializer.serialize(drawing), before);
	assert.equal(harness.history.length, 0);
	assert.equal(harness.changes, 0);
});

test("the combined atom limit is checked before insertion", async () => {
	const drawing = serializer.deserialize(curvedArrowsKet);
	while (drawing.atoms.size < MAX_MOLECULE_ATOMS - 2) {
		drawing.atoms.add(new Atom({ label: "C", pp: new Vec2(drawing.atoms.size, 0) }));
	}
	const before = serializer.serialize(drawing);
	const harness = editorHarness(drawing);
	await assert.rejects(insertChemicalStructure(harness.editor, "CCO", () => true), /at most 512 atoms/);
	assert.equal(serializer.serialize(drawing), before);
	assert.equal(harness.history.length, 0);
});

test("a Molfile reference retains charge, stereo and relative layout when dropped onto a panned zoomed canvas", async () => {
	const reference = await normalizeMolecule({ smiles: "C[C@H]([NH3+])C/C=C/C" });
	const originalReference = new MolSerializer().deserialize(reference.molfile);
	const expected = originalReference.clone();
	expected.rescale();
	const drawing = serializer.deserialize(curvedArrowsKet);
	const before = serializer.serialize(drawing);
	const harness = editorHarness(drawing, async () => { throw new Error("A Molfile must not be regenerated from SMILES."); });
	harness.editor.editor.render.options.zoom = .5;
	harness.editor.editor.render.viewBox.minX = 80;
	harness.editor.editor.render.viewBox.minY = -40;
	await insertChemicalStructure(harness.editor, reference.molfile, () => true, { clientX: 300, clientY: 150 });
	const selection = harness.selection!;
	const snapshot = selectedMoleculeSnapshot(drawing, selection);
	const inserted = serializer.deserialize(snapshot.ket!);
	assert.equal(await smilesFromMolfile(snapshot.molfile!), await smilesFromMolfile(reference.molfile), "formal charge, tetrahedral and alkene stereochemistry survive paste");
	assert.equal([...inserted.atoms.values()].reduce((charge, atom) => charge + (atom.charge ?? 0), 0), 1);
	const bounds = inserted.getCoordBoundingBox();
	// Pointer (300,150), client origin (100,50), zoom .5 and viewBox
	// offset (80,-40) give model coordinates (12,4) at 40 px per unit.
	assert.ok(Math.abs((bounds.min.x + bounds.max.x) / 2 - 12) < 1e-8);
	assert.ok(Math.abs((bounds.min.y + bounds.max.y) / 2 - 4) < 1e-8);
	const first = inserted.atoms.get(0)!;
	const expectedFirst = expected.atoms.get(0)!;
	for (const [id, atom] of inserted.atoms) {
		const original = expected.atoms.get(id)!;
		assert.ok(Math.abs(atom.pp.x - first.pp.x - (original.pp.x - expectedFirst.pp.x)) < 1e-8);
		assert.ok(Math.abs(atom.pp.y - first.pp.y - (original.pp.y - expectedFirst.pp.y)) < 1e-8);
	}
	assert.equal(harness.history.length, 1);
	harness.history[0]!.perform(harness.ctab);
	assert.equal(serializer.serialize(drawing), before);
});

test("pasting reference KET retains alternating double bonds and its scoped arrows", async () => {
	const input = JSON.stringify({
		root: { nodes: [{ $ref: "mol0" }, { type: "arrow", data: { mode: "elliptical-arc-arrow-open-angle", pos: [{ x: 0, y: -2, z: 0 }, { x: 1, y: -2, z: 0 }], height: .4 } }] },
		mol0: {
			type: "molecule", atoms: Array.from({ length: 6 }, (_, index) => ({ label: "C", location: [Math.cos(index * Math.PI / 3), Math.sin(index * Math.PI / 3), 0] })),
			bonds: Array.from({ length: 6 }, (_, index) => ({ type: index % 2 + 1, atoms: [index, (index + 1) % 6] })),
		},
	});
	const drawing = serializer.deserialize(curvedArrowsKet);
	const before = serializer.serialize(drawing);
	const harness = editorHarness(drawing, async () => { throw new Error("Reference KET must preserve its own drawing."); });
	await insertChemicalStructure(harness.editor, input, () => true);
	assert.deepEqual(harness.selection!.bonds!.map(id => drawing.bonds.get(id)!.type), [1, 2, 1, 2, 1, 2]);
	assert.equal(drawing.rxnArrows.size, 3);
	const arrow = drawing.rxnArrows.get(2)!;
	assert.equal(arrow.mode, "elliptical-arc-arrow-open-angle");
	assert.ok(Math.abs(arrow.height! - .4) < 1e-8);
	assert.ok(Math.abs(arrow.pos[1]!.x - arrow.pos[0]!.x - 1) < 1e-8);
	assert.equal(harness.history.length, 1);
	harness.history[0]!.perform(harness.ctab);
	assert.equal(serializer.serialize(drawing), before);
});

test("a precomputed model drop stays fixed when the dialog and viewport move during preparation", async () => {
	const drawing = serializer.deserialize(curvedArrowsKet);
	const before = serializer.serialize(drawing);
	let finish!: (value: { struct: string }) => void;
	const harness = editorHarness(drawing, () => new Promise(resolve => { finish = resolve; }));
	const inserting = insertChemicalStructure(harness.editor, "CCO", () => true, { modelX: 12, modelY: 4 });
	// A loading message/sidebar can resize the dialog; pan and zoom may also
	// differ from the viewport where the caller captured the pointer drop.
	harness.editor.editor.render.clientArea.getBoundingClientRect = () => ({ left: 500, top: 350 }) as DOMRect;
	harness.editor.editor.render.options.zoom = 2;
	harness.editor.editor.render.viewBox.minX = -400;
	harness.editor.editor.render.viewBox.minY = 800;
	finish({ struct: ethanolKet });
	await inserting;
	const inserted = serializer.deserialize(selectedMoleculeSnapshot(drawing, harness.selection!).ket!);
	const bounds = inserted.getCoordBoundingBox();
	assert.ok(Math.abs((bounds.min.x + bounds.max.x) / 2 - 12) < 1e-8);
	assert.ok(Math.abs((bounds.min.y + bounds.max.y) / 2 - 4) < 1e-8);
	assert.equal(harness.history.length, 1);
	harness.history[0]!.perform(harness.ctab);
	assert.equal(serializer.serialize(drawing), before);
});
