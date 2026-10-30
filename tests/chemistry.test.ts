import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import {
	ChemistryInputError, moleculeInput, moleculeMarkdown,
	parseMoleculeBlock, parseMoleculeDocument, parseMoleculeSource,
} from "../src/core/chemistry.ts";
import {
	chemistryConformerResponse, chemistryNormalizeResponse,
	generateConformer, normalizeMolecule, normalizeMoleculeDocument,
} from "../src/server/chemistry.ts";

test("molecule fences preserve SMILES syntax and version their portable source", () => {
	const molecule = parseMoleculeBlock("C[C@H](O)C(=O)[O-]\n", "smiles");
	assert.equal(molecule.smiles, "C[C@H](O)C(=O)[O-]");
	assert.equal(molecule.version, 1);
	const markdown = moleculeMarkdown(molecule);
	assert.deepEqual(parseMoleculeBlock(markdown.split("\n")[1]!), molecule);
	assert.throws(() => parseMoleculeBlock('{"smiles":'), ChemistryInputError);
	assert.throws(() => parseMoleculeSource({ version: 2, smiles: "CC" }), /version/);
	assert.throws(() => parseMoleculeSource({ smiles: "C".repeat(16_001) }), /oversized/);
	assert.throws(() => parseMoleculeSource({ smiles: "\0" }), /Invalid/);
	assert.throws(() => parseMoleculeSource({ sdf: "molfile\n$$$$\nsecond\n$$$$" }), /one SDF/);
});

test("chemical normalization rejects invalid valence and empty structures", async () => {
	await assert.rejects(normalizeMolecule({ smiles: "CO(C)C" }), /could not be read/);
	await assert.rejects(normalizeMolecule({ smiles: "c1cc" }), /could not be read/);
	await assert.rejects(normalizeMolecule({ molfile: "garbage" }), /could not be read/);
	await assert.rejects(normalizeMolecule({ smiles: "C".repeat(513) }), /at most 512 atoms/);
});

test("normalization preserves charge, aromaticity and specified stereochemistry", async () => {
	for (const smiles of ["c1ccccc1", "C[NH3+]", "C[C@H](O)CC", "C/C=C/C", "[13CH3]CO"]) {
		const first = await normalizeMolecule({ smiles });
		const second = await normalizeMolecule({ molfile: first.molfile });
		assert.equal(second.smiles, first.smiles, smiles);
	}
	const left = await normalizeMolecule({ smiles: "C[C@H](O)CC" });
	const right = await normalizeMolecule({ smiles: "C[C@@H](O)CC" });
	assert.notEqual(left.smiles, right.smiles);
});

test("answer normalization derives SMILES from authoritative Molfile and retains inert editor data", async () => {
	const ethanol = await normalizeMolecule({ smiles: "CCO", label: "My answer" });
	const source = { ...ethanol, smiles: "CC(=O)O", ket: '{"root":{"nodes":[]}}' };
	assert.equal(moleculeInput(source), ethanol.molfile);
	const saved = await normalizeMoleculeDocument(source);
	assert.equal(saved.smiles, "CCO");
	assert.equal(saved.label, "My answer");
	assert.equal(saved.ket, source.ket);
	assert.throws(() => parseMoleculeDocument({ ...source, ket: "[]" }), /editor/);
	assert.throws(() => parseMoleculeDocument({ ...source, version: 2 }), /version/);
	assert.throws(() => parseMoleculeDocument({ smiles: "CCO" }), /version 1/);
});

test("normalization endpoint returns a local error for malformed and oversized requests", async () => {
	const request = (body: string) => new Request("http://localhost/api/chemistry/normalize", { method: "POST", body });
	const invalid = await chemistryNormalizeResponse(request("not JSON"));
	assert.equal(invalid.status, 400);
	const oversized = await chemistryNormalizeResponse(request(" ".repeat(1_000_001)));
	assert.equal(oversized.status, 400);
	const valid = await chemistryNormalizeResponse(request(JSON.stringify({ smiles: "CCO" })));
	assert.equal(valid.status, 200);
	assert.equal((await valid.json()).smiles, "CCO");
});

const hasPython = Boolean(process.env.LH_CHEMISTRY_PYTHON) || existsSync(".venv-chemistry/bin/python") || existsSync(".venv-chemistry/Scripts/python.exe");

test("3D generation creates reproducible non-flat geometry and preserves stereo", { skip: !hasPython }, async () => {
	const source = { smiles: "C[C@H](O)CC" };
	const normalized = await normalizeMolecule(source);
	const result = await generateConformer(source);
	assert.equal(result.generated, true);
	assert.match(result.sdf, /3D/);
	const lines = result.sdf.split("\n");
	const count = Number(lines[3]!.slice(0, 3));
	const z = lines.slice(4, 4 + count).map(line => Number(line.slice(20, 30)));
	assert.ok(z.some(value => Math.abs(value) > 0.1), "A 3D model must not reuse flat drawing coordinates");
	const roundTrip = await normalizeMolecule({ molfile: result.sdf.split("$$$$")[0]! });
	assert.equal(roundTrip.smiles, normalized.smiles);
	const repeated = await generateConformer(source);
	assert.equal(repeated.sdf, result.sdf);
	const imported = await generateConformer({ ...source, sdf: result.sdf });
	assert.equal(imported.generated, false);
	assert.match(imported.sdf, /3D/);
	await assert.rejects(generateConformer({ smiles: "CCO", sdf: result.sdf }), /different structure/);
	const alkene = await generateConformer({ smiles: "C/C=C/C" });
	assert.equal((await normalizeMolecule({ sdf: alkene.sdf })).smiles, "C/C=C/C");
});

test("3D generation labels unspecified stereo and rejects disconnected structures", { skip: !hasPython }, async () => {
	const possible = await generateConformer({ smiles: "CC(O)CC" });
	assert.match(possible.warning ?? "", /Stereochemistry is unspecified/);
	const response = await chemistryConformerResponse(new Request("http://localhost/api/chemistry/conformer", { method: "POST", body: JSON.stringify({ smiles: "[Na+].[Cl-]" }) }));
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /connected molecule/);
});

test("missing local helper is an actionable 503 and does not prevent 2D normalization", async () => {
	const original = process.env.LH_CHEMISTRY_PYTHON;
	try {
		process.env.LH_CHEMISTRY_PYTHON = "/nonexistent-learnharness-chemistry-python";
		const makeRequest = () => new Request("http://localhost/api/chemistry/conformer", { method: "POST", body: JSON.stringify({ smiles: "CCO" }) });
		const unavailable = await chemistryConformerResponse(makeRequest());
		assert.equal(unavailable.status, 503);
		assert.match((await unavailable.json()).error, /setup-chemistry.py/);
		const drawing = await chemistryNormalizeResponse(makeRequest());
		assert.equal(drawing.status, 200);
		assert.equal((await drawing.json()).smiles, "CCO");
	} finally {
		if (original === undefined) delete process.env.LH_CHEMISTRY_PYTHON;
		else process.env.LH_CHEMISTRY_PYTHON = original;
	}
});

test("validated imported 3D works without starting the optional generator", { skip: !hasPython }, async () => {
	const source = { smiles: "CCO" };
	const generated = await generateConformer(source);
	const original = process.env.LH_CHEMISTRY_PYTHON;
	try {
		process.env.LH_CHEMISTRY_PYTHON = "/nonexistent-learnharness-chemistry-python";
		const response = await chemistryConformerResponse(new Request("http://localhost/api/chemistry/conformer", { method: "POST", body: JSON.stringify({ ...source, sdf: generated.sdf }) }));
		assert.equal(response.status, 200);
		const imported = await response.json();
		assert.equal(imported.generated, false);
		assert.match(imported.sdf, /3D/);
	} finally {
		if (original === undefined) delete process.env.LH_CHEMISTRY_PYTHON;
		else process.env.LH_CHEMISTRY_PYTHON = original;
	}
});
