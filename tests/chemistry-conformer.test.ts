import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chemistryConformerResponse, chemistryPython, generateConformer, normalizeMolecule } from "../src/server/chemistry.ts";
import type { ConformerResult } from "../src/core/chemistry.ts";

const hasPython = Boolean(process.env.LH_CHEMISTRY_PYTHON) || existsSync(".venv-chemistry/bin/python") || existsSync(".venv-chemistry/Scripts/python.exe");
const request = (body: unknown) => new Request("http://localhost/api/chemistry/conformer", { method: "POST", body: JSON.stringify(body) });

test("ranked search fixes the cyclohexane local-minimum regression and retains both chairs", { skip: !hasPython }, async () => {
	// Use the same server-normalized Molfile and atom order as the application.
	const source = await normalizeMolecule({ smiles: "Br[C@H]1[C@H](C)CCCC1" });
	const response = await chemistryConformerResponse(request(source));
	assert.equal(response.status, 200);
	const result = await response.json() as ConformerResult;
	const conformers = result.conformers!;
	assert.equal(result.search?.method, "MMFF94");
	assert.equal(result.search?.requested, 128);
	assert.equal(result.search?.embedded, 128);
	assert.equal(result.search?.stereoRejected, 0);
	assert.equal(result.search?.unique, conformers.length);
	assert.equal(result.search?.returned, conformers.length);
	assert.equal(result.search?.energyUnit, "kcal/mol");
	assert.equal(result.search?.exhaustive, false);
	assert.equal(result.sdf, conformers[0]!.sdf);
	assert.equal(conformers[0]!.relativeEnergy, 0);
	assert.equal(conformers[0]!.rings[0]!.shape, "chair");
	assert.ok(conformers[0]!.energy > 6 && conformers[0]!.energy < 8);
	const chairs = conformers.filter(conformer => conformer.rings[0]?.shape === "chair");
	assert.deepEqual(new Set(chairs.map(conformer => conformer.rings[0]!.chairBasin)), new Set(["positive", "negative"]));
	assert.ok(chairs[1]!.relativeEnergy > 0.3 && chairs[1]!.relativeEnergy < 0.7);
	assert.deepEqual(chairs.map(conformer => conformer.rings[0]!.substituents?.map(group => [group.label, group.orientation])), [
		[["Br", "equatorial"], ["Me", "equatorial"]],
		[["Br", "axial"], ["Me", "axial"]],
	]);
	assert.deepEqual(chairs[0]!.rings[0]!.substituents?.map(group => [group.atomIndex, group.substituentAtomIndex]),
		chairs[1]!.rings[0]!.substituents?.map(group => [group.atomIndex, group.substituentAtomIndex]));
	const nonChair = conformers.find(conformer => conformer.rings[0]?.shape === "non-chair")!;
	assert.ok(nonChair.relativeEnergy > 4 && nonChair.relativeEnergy < 5, "The previous non-chair minimum belongs above the chairs");
	assert.ok(conformers.filter(conformer => conformer.rings[0]?.shape !== "chair")
		.every(conformer => conformer.rings[0]?.substituents === undefined));
	assert.equal(new Set(conformers.map(conformer => conformer.id)).size, conformers.length);
	for (let i = 0; i < conformers.length; i++) {
		assert.ok(Number.isFinite(conformers[i]!.energy));
		assert.ok(i === 0 || conformers[i]!.energy >= conformers[i - 1]!.energy);
		assert.ok(Math.abs(conformers[i]!.relativeEnergy - (conformers[i]!.energy - conformers[0]!.energy)) < 1e-8);
		assert.equal((await normalizeMolecule({ sdf: conformers[i]!.sdf })).smiles, source.smiles);
	}
});

test("symmetry dedup retains two pedagogical chair basins in unsubstituted cyclohexane", { skip: !hasPython }, async () => {
	const result = await generateConformer({ smiles: "C1CCCCC1" });
	const chairs = result.conformers!.filter(conformer => conformer.rings[0]?.shape === "chair");
	assert.equal(chairs.length, 2);
	assert.notEqual(chairs[0]!.rings[0]!.chairBasin, chairs[1]!.rings[0]!.chairBasin);
	assert.ok(Math.abs(chairs[0]!.energy - chairs[1]!.energy) < 1e-5);
	assert.ok(chairs.every(conformer => conformer.rings[0]?.substituents === undefined));
});

test("every ranked geometry preserves specified E/Z and one consistent unspecified stereoisomer", { skip: !hasPython }, async () => {
	for (const smiles of ["C/C=C/C", "C/C=C\\C", "CC(O)CC", "CC=CC", "C[C@H](O)C(O)C"]) {
		const result = await generateConformer({ smiles });
		const expected = await normalizeMolecule({ smiles: result.search!.isomericSmiles });
		if (smiles.includes("/")) {
			assert.equal(expected.smiles, (await normalizeMolecule({ smiles })).smiles);
			assert.equal(result.search?.stereochemistry, "specified");
		} else {
			assert.equal(result.search?.stereochemistry, "assigned-for-search");
			assert.match(result.warning!, /other stereoisomers were not compared/);
		}
		for (const conformer of result.conformers!) assert.equal((await normalizeMolecule({ sdf: conformer.sdf })).smiles, expected.smiles);
	}
});

test("UFF fallback labels the whole ensemble and imported coordinates require an explicit search", { skip: !hasPython }, async () => {
	const fallback = await generateConformer({ smiles: "B(O)O" });
	assert.equal(fallback.search?.method, "UFF");
	assert.match(fallback.warning!, /all conformers.*UFF/);
	const source = { sdf: fallback.sdf };
	const imported = await generateConformer(source);
	assert.equal(imported.generated, false);
	assert.equal(imported.search, undefined);
	assert.equal(imported.conformers, undefined);
	const response = await chemistryConformerResponse(request({ ...source, search: true }));
	assert.equal(response.status, 200);
	const searched = await response.json() as ConformerResult;
	assert.equal(searched.generated, true);
	assert.equal(searched.search?.method, "UFF");
	assert.equal((await chemistryConformerResponse(request({ ...source, search: "yes" }))).status, 400);
});

test("independent geometry, substituent orientation, and stereo/convergence/alignment rejection checks", { skip: !hasPython }, () => {
	const output = execFileSync(chemistryPython(), ["tests/chemistry-conformer-fixtures.py"], { encoding: "utf8", timeout: 30_000 });
	assert.match(output, /Geometry fixtures.*passed/);
});
