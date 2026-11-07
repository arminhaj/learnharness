import assert from "node:assert/strict";
import test from "node:test";
import { snapshotEditor } from "../components/chemistry/editor-snapshot.ts";
import { normalizeMolecule } from "../src/server/chemistry.ts";
import { curvedArrowsKet } from "./fixtures/curved-arrows.ts";

test("editor snapshot preserves both arrowheads while exporting molecule chemistry from the same drawing", async () => {
	let snapshots = 0;
	const editor = {
		getKet: async () => { snapshots++; return curvedArrowsKet; },
	};
	const answer = await snapshotEditor(editor, "My mechanism");
	assert.equal(snapshots, 1);
	assert.equal(answer.ket, curvedArrowsKet);
	assert.equal(answer.smiles, "CCO");
	assert.equal(answer.label, "My mechanism");
	assert.doesNotMatch(answer.molfile, /arrow|>>/);
	const normalized = await normalizeMolecule(answer);
	assert.equal(normalized.ket, curvedArrowsKet);
});
