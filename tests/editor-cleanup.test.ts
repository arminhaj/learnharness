import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import createIndigo, { type IndigoModule, type IndigoOptions } from "indigo-ketcher";
import { ChemicalMimeType, KetSerializer, type CleanData, type StructService, type StructServiceProvider } from "ketcher-core";
import { editorErrorMessage, withEditorCleanup } from "../components/chemistry/editor-cleanup.ts";

interface IntVector { push_back(value: number): void; delete(): void }
type CleanupIndigo = IndigoModule & {
	VectorInt: new () => IntVector;
	clean2d(source: string, format: string, options: IndigoOptions, selection: IntVector): string;
};
const fixture = readFileSync(new URL("./fixtures/cleanup-selection.ket", import.meta.url), "utf8");
const input: CleanData = { struct: fixture, output_format: ChemicalMimeType.KET, selected: Array.from({ length: 9 }, (_, index) => index + 10) };

function serviceWith(clean: StructService["clean"]) {
	const original = { clean, destroy() {} } as StructService;
	const provider: StructServiceProvider = { mode: "standalone", createStructService: () => original };
	const wrapped = withEditorCleanup(provider).createStructService({});
	assert.equal(wrapped, original, "the standalone worker's lifecycle and other methods remain on the same service");
	return wrapped;
}

test("selected Clean Up works on the reported drawing with curved arrows without moving other molecules or ions", async () => {
	const indigo = await createIndigo() as CleanupIndigo;
	const nativeClean: StructService["clean"] = async data => {
		const options = new indigo.MapStringString();
		const selection = new indigo.VectorInt();
		data.selected?.forEach(index => selection.push_back(index));
		try {
			return { struct: indigo.clean2d(data.struct, "ket", options, selection), format: ChemicalMimeType.KET };
		} catch (reason) {
			// This is how ketcher-standalone delivers rejected worker commands.
			throw new Error(String(reason));
		} finally { options.delete(); selection.delete(); }
	};
	await assert.rejects(nativeClean(input), /<reaction> is not a base molecule/, "the real Indigo engine reproduces the original cleanup error");
	const service = serviceWith(nativeClean);
	for (const mode of ["elliptical-arc-arrow-open-angle", "elliptical-arc-arrow-open-half-angle"]) {
		const before = JSON.parse(fixture);
		before.root.nodes[3].data.mode = mode;
		const request = { ...input, struct: JSON.stringify(before) };
		const result = await service.clean(request);
		const after = JSON.parse(result.struct);
		assert.deepEqual(after.root, before.root, "arrow positions, height, ordering and other annotations are preserved exactly");
		assert.deepEqual(after.mol0, before.mol0, "the unselected starting material remains byte-for-byte equivalent");
		assert.deepEqual(after.mol2, before.mol2, "the unselected bromide stays at its original position with its charge");
		assert.notDeepEqual(after.mol1.atoms.map((atom: { location: number[] }) => atom.location), before.mol1.atoms.map((atom: { location: number[] }) => atom.location), "the selected molecule's geometry is cleaned");
		assert.deepEqual(after.mol1.atoms.map((atom: { label: string; charge?: number; stereoLabel?: string }) => [atom.label, atom.charge, atom.stereoLabel]), before.mol1.atoms.map((atom: { label: string; charge?: number; stereoLabel?: string }) => [atom.label, atom.charge, atom.stereoLabel]), "atom identity, formal charges and stereocenters survive");
		assert.deepEqual(after.mol1.bonds, before.mol1.bonds, "bond orders and wedge stereochemistry survive");
		assert.doesNotThrow(() => new KetSerializer().deserialize(result.struct));
		const serializer = new KetSerializer();
		const originalCanvas = serializer.deserialize(request.struct);
		const loadedCanvas = serializer.deserialize(result.struct);
		originalCanvas.rescale(); loadedCanvas.rescale();
		for (const id of [...Array.from({ length: 10 }, (_, index) => index), 19]) {
			const a = originalCanvas.atoms.get(id)!.pp, b = loadedCanvas.atoms.get(id)!.pp;
			assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-10, "Ketcher's load-time normalization does not move unselected atoms");
		}
		for (let index = 0; index < 2; index++) {
			const a = originalCanvas.rxnArrows.get(0)!.pos[index]!, b = loadedCanvas.rxnArrows.get(0)!.pos[index]!;
			assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-10, "Ketcher's load-time normalization does not move arrow endpoints");
		}
		assert.equal(request.struct, JSON.stringify(before), "the input snapshot remains immutable");
	}
	const multi = await service.clean({ ...input, selected: [...Array.from({ length: 19 }, (_, index) => index)] });
	assert.deepEqual(JSON.parse(multi.struct).mol2, JSON.parse(fixture).mol2, "cleaning multiple selected molecules still leaves the ion untouched");
});

test("ordinary cleanup and real reaction schemes retain the vendor path", async () => {
	const calls: CleanData[] = [];
	const service = serviceWith(async data => { calls.push(data); return { struct: data.struct, format: ChemicalMimeType.KET }; });
	await service.clean({ ...input, selected: undefined });
	assert.equal(calls[0]!.struct, fixture);
	const noArrow = JSON.parse(fixture); noArrow.root.nodes.pop();
	const moleculeRequest = { ...input, struct: JSON.stringify(noArrow) };
	await service.clean(moleculeRequest);
	assert.equal(calls[1], moleculeRequest);
	const reaction = JSON.parse(fixture); reaction.root.nodes[3].data.mode = "open-angle";
	const reactionRequest = { ...input, struct: JSON.stringify(reaction) };
	await service.clean(reactionRequest);
	assert.equal(calls[2], reactionRequest);
	const grouped = JSON.parse(fixture); grouped.root.nodes.unshift({ $ref: "rg0" }); grouped.rg0 = { type: "rgroup" };
	const groupedRequest = { ...input, struct: JSON.stringify(grouped) };
	await service.clean(groupedRequest);
	assert.equal(calls[3], groupedRequest, "unsupported root references cannot shift the selected-atom mapping");
});

test("failed or topology-changing cleanup cannot deliver a partially replaced drawing", async () => {
	let calls = 0;
	const failure = new Error("Cleanup failed");
	const service = serviceWith(async data => {
		calls++;
		if (calls === 2) throw failure;
		return { struct: data.struct, format: ChemicalMimeType.KET };
	});
	const request = { ...input, selected: [0, 10] };
	await assert.rejects(service.clean(request), failure);
	assert.equal(calls, 2);
	assert.equal(request.struct, fixture);
	const changed = serviceWith(async data => {
		const result = JSON.parse(data.struct);
		result[result.root.nodes[0].$ref].atoms.pop();
		return { struct: JSON.stringify(result), format: ChemicalMimeType.KET };
	});
	await assert.rejects(changed.clean(input), /drawing has not been changed/);
});

test("vendor errors always become renderable messages", () => {
	assert.equal(editorErrorMessage(new Error("Cleanup failed")), "Cleanup failed");
	assert.equal(editorErrorMessage("Select a molecule"), "Select a molecule");
	assert.equal(editorErrorMessage({ message: "Worker failed" }), "Worker failed");
	for (const reason of [undefined, null, {}, { message: {} }, "", "   ", new Error()]) {
		assert.equal(editorErrorMessage(reason), "Could not complete this drawing operation.");
	}
});
