import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chemistryConformerResponse, normalizeMolecule } from "../src/server/chemistry.ts";

const substituent = { atomIndex: 1, substituentAtomIndex: 0, label: "Br", orientation: "equatorial" };
const chair = {
	atomIndices: [1, 2, 3, 4, 5, 6], shape: "chair", theta: 2, amplitude: 0.5,
	torsions: [55, -55, 55, -55, 55, -55], chairBasin: "positive",
	substituents: [substituent],
};

// Exercise the subprocess/API boundary, without requiring Python or trusting a
// type assertion to stand in for malformed helper output. The fixture executable
// consumes stdin exactly as the helper does and returns the selected JSON file.
test("conformer API validates optional chair summaries from its local helper", { skip: process.platform === "win32" }, async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "learnharness-summary-validation-"));
	const responsePath = path.join(directory, "response.json");
	const helperPath = path.join(directory, "helper");
	const original = process.env.LH_CHEMISTRY_PYTHON;
	try {
		await writeFile(helperPath, `#!${process.execPath}\nconst fs = require("node:fs");\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write(fs.readFileSync(${JSON.stringify(responsePath)}, "utf8")));\n`);
		await chmod(helperPath, 0o700);
		process.env.LH_CHEMISTRY_PYTHON = helperPath;
		const source = await normalizeMolecule({ smiles: "BrC1CCCCC1" });
		const respond = async (rings: unknown[], fixtureSource = source) => {
			const sdf = fixtureSource.molfile + "\n$$$$\n";
			await writeFile(responsePath, JSON.stringify({
				sdf, generated: true,
				conformers: [{ id: "conformer-1", sdf, energy: 5, relativeEnergy: 0, rings }],
				search: {
					method: "MMFF94", requested: 128, embedded: 1, converged: 1, stereoRejected: 0,
					unique: 1, returned: 1, rmsdThreshold: 0.25, seed: 0xC0DE,
					stereochemistry: "specified", isomericSmiles: fixtureSource.smiles, energyUnit: "kcal/mol", exhaustive: false,
				},
			}));
			return chemistryConformerResponse(new Request("http://localhost/api/chemistry/conformer", {
				method: "POST", body: JSON.stringify(fixtureSource),
			}));
		};
		await t.test("accepts the compact summary and preserves atom identities", async () => {
			const response = await respond([chair]);
			assert.equal(response.status, 200);
			assert.deepEqual((await response.json()).conformers[0].rings[0].substituents, [substituent]);
		});
		await t.test("accepts older helpers without a summary", async () => {
			const response = await respond([{ ...chair, substituents: undefined }]);
			assert.equal(response.status, 200);
			assert.equal((await response.json()).conformers[0].rings[0].substituents, undefined);
		});
		await t.test("accepts two opposite substituents on a geminal carbon", async () => {
			const response = await respond([{ ...chair, substituents: [substituent, {
				atomIndex: 1, substituentAtomIndex: 7, label: "Me", orientation: "axial",
			}] }], await normalizeMolecule({ smiles: "BrC1(CCCCC1)C" }));
			assert.equal(response.status, 200);
		});
		const corruptGroups: [string, unknown][] = [
			["null entry", null],
			["foreign attachment atom", { ...substituent, atomIndex: 8 }],
			["string attachment atom", { ...substituent, atomIndex: "1" }],
			["ring atom as substituent", { ...substituent, substituentAtomIndex: 2 }],
			["negative substituent atom", { ...substituent, substituentAtomIndex: -1 }],
			["fractional substituent atom", { ...substituent, substituentAtomIndex: 0.5 }],
			["oversized substituent atom", { ...substituent, substituentAtomIndex: 512 }],
			["unknown abbreviation", { ...substituent, label: "invented group" }],
			["missing abbreviation", { ...substituent, label: undefined }],
			["unknown orientation", { ...substituent, orientation: "up" }],
		];
		const corruptRings: [string, Record<string, unknown>][] = [
			...corruptGroups.map(([name, group]): [string, Record<string, unknown>] => [name, { substituents: [group] }]),
			["non-chair summary", { shape: "non-chair", chairBasin: undefined }],
			["null summary", { substituents: null }],
			["non-array summary", { substituents: {} }],
			["empty summary", { substituents: [] }],
			["oversized summary", { substituents: Array(13).fill(substituent) }],
			["duplicate substituent atom", { substituents: [substituent, { ...substituent, atomIndex: 2 }] }],
			["two equatorial bonds on one carbon", { substituents: [substituent, { ...substituent, substituentAtomIndex: 7 }] }],
		];
		for (const [name, invalid] of corruptRings) await t.test(`rejects ${name}`, async () => {
			const response = await respond([{ ...chair, ...invalid }]);
			assert.equal(response.status, 503);
			assert.equal((await response.json()).conformers, undefined);
		});
		await t.test("rejects a summary attached to a multiple-ring response", async () => {
			assert.equal((await respond([chair, { ...chair, substituents: undefined }])).status, 503);
		});
	} finally {
		if (original === undefined) delete process.env.LH_CHEMISTRY_PYTHON;
		else process.env.LH_CHEMISTRY_PYTHON = original;
		await rm(directory, { recursive: true, force: true });
	}
});
