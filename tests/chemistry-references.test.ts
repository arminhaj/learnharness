import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MOLECULE_REFERENCES, collectMoleculeReferences, parseMoleculeReferences, publicChemistryContext } from "../src/core/chemistry-references.ts";
import type { MoleculeSource } from "../src/core/chemistry.ts";

const fence = (source: MoleculeSource) => `\`\`\`molecule\n${JSON.stringify(source)}\n\`\`\``;
const reference = { id: "starting-material", name: "Starting material", source: { smiles: "CCO" } };

test("reference banks accept legacy absence and validate standalone portable sources", () => {
	assert.deepEqual(parseMoleculeReferences(undefined), []);
	assert.deepEqual(parseMoleculeReferences([]), []);
	assert.deepEqual(parseMoleculeReferences([{ ...reference, name: "  Starting material  " }]), [{ ...reference, source: { version: 1, smiles: "CCO" } }]);
	const input = [{ ...reference, source: { smiles: "C[C@H](O)CC", label: "Chiral alcohol", ket: '{"root":{"nodes":[]}}' } }];
	const parsed = parseMoleculeReferences(input);
	assert.equal(parsed[0]!.source.smiles, "C[C@H](O)CC");
	assert.equal(parsed[0]!.source.ket, input[0]!.source.ket);
	input[0]!.source.label = "Mutated later";
	assert.equal(parsed[0]!.source.label, "Chiral alcohol");
});

test("reference banks reject malformed identity, oversized text, nested syntheses, and invalid sources", () => {
	for (const value of [
		null, {}, "references", [null], [{ ...reference, id: "unsafe/id" }], [{ ...reference, id: "x".repeat(101) }],
		[reference, reference], [{ ...reference, name: " " }], [{ ...reference, name: "x".repeat(121) }], [{ ...reference, name: "hidden\nline" }],
		[{ ...reference, source: null }], [{ ...reference, source: { smiles: "C".repeat(16_001) } }],
		[{ ...reference, source: { smiles: "CCO", steps: [{ id: "a", name: "Step", smiles: "CCO" }] } }],
		Array.from({ length: MAX_MOLECULE_REFERENCES + 1 }, (_, index) => ({ ...reference, id: `ref-${index}` })),
	]) assert.throws(() => parseMoleculeReferences(value));
});

test("reference banks enforce a total byte budget including Unicode and editor drawings", () => {
	const ket = JSON.stringify({ note: "x".repeat(400_000) });
	assert.throws(() => parseMoleculeReferences(Array.from({ length: 3 }, (_, index) => ({ ...reference, id: `ref-${index}`, source: { smiles: "CCO", ket } }))));
	const unicodeKet = JSON.stringify({ note: "\uD83D\uDE00".repeat(240_000) });
	assert.throws(() => parseMoleculeReferences([{ ...reference, source: { smiles: "CCO", ket: unicodeKet } }, { ...reference, id: "second", source: { smiles: "CCN", ket: unicodeKet } }]));
});

test("collection extracts complete visible molecule and SMILES fences while preserving labels and stereo", () => {
	const references = collectMoleculeReferences([
		`Question\n${fence({ smiles: "C[C@H](O)CC", label: "Starting alcohol" })}`,
		"~~~smiles\nC/C=C/C\n~~~",
		"````molecule\n{\"smiles\":\"[Na+].[Cl-]\"}\n````",
	]);
	assert.deepEqual(references.map(item => [item.name, item.source.smiles]), [["Starting alcohol", "C[C@H](O)CC"], ["Structure 2", "C/C=C/C"], ["Structure 3", "[Na+].[Cl-]"]]);
	assert.ok(references.every(item => /^reference-[a-f0-9]+-[a-f0-9]+$/.test(item.id)));
	assert.deepEqual(parseMoleculeReferences(references), references);
});

test("quoted/list fences are supported but literals and unfinished streamed fences are ignored", () => {
	const references = collectMoleculeReferences([
		"> ```smiles\n> CCO\n> ```",
		"- ```smiles\n  CCN\n  ```",
		"````text\n```smiles\nCCCl\n```\n````",
		"```smiles\nCCBr",
		"```smiles\nCCI\n",
		"```smiles\nCCC\n     ```",
		"```molecule\n{\"smiles\":\"CCF\"}\n~~~",
		"```molecule\n{not JSON}\n```",
		"Inline `smiles C=S` and sulfuric acid by name are not structural blocks.",
	]);
	assert.deepEqual(references.map(item => item.source.smiles), ["CCO", "CCN"]);
});

test("deduplication uses molecular identity, keeps stereoisomers distinct, and derives stable ids", () => {
	const first = { smiles: "C[C@H](O)CC", label: "First label" };
	const second = { smiles: "C[C@@H](O)CC", label: "Other stereoisomer" };
	const references = collectMoleculeReferences([fence(first), fence({ ...first, label: "Duplicate label" }), fence(second)], [{ ...first }]);
	assert.equal(references.length, 2);
	assert.equal(references[0]!.name, "First label");
	const reversed = collectMoleculeReferences([fence(second), fence(first)]);
	assert.equal(references[0]!.id, reversed[1]!.id);
	assert.equal(references[1]!.id, reversed[0]!.id);
});

test("distinct supplied drawings and conformers of the same chemical remain separate references", () => {
	const source = { smiles: "CCO", label: "First layout", molfile: "first 2D coordinates" };
	const ket = JSON.stringify({ root: { nodes: [] }, drawingCoordinates: [0, 1, 2] });
	const references = collectMoleculeReferences([], [
		source,
		{ ...source, label: "Same layout under another name" },
		{ ...source, label: "Second layout", molfile: "different 2D coordinates" },
		{ ...source, label: "First editable drawing", ket },
		{ ...source, label: "Second editable drawing", ket: JSON.stringify({ root: { nodes: [] }, drawingCoordinates: [2, 1, 0] }) },
		{ smiles: "CCO", label: "First conformer", sdf: "first 3D coordinates" },
		{ smiles: "CCO", label: "Second conformer", sdf: "second 3D coordinates" },
	]);
	assert.deepEqual(references.map(item => item.name), ["First layout", "Second layout", "First editable drawing", "Second editable drawing", "First conformer", "Second conformer"]);
	assert.equal(new Set(references.map(item => item.id)).size, 6);
});

test("complete synthesis blocks flatten to standalone labeled step references", () => {
	const source: MoleculeSource = {
		smiles: "CCO", label: "Overall sequence",
		steps: [
			{ smiles: "CCO", id: "first", name: "Initial alcohol", label: "Alcohol reagent" },
			{ smiles: "C=C", id: "second", name: "Elimination product" },
		],
	};
	const references = collectMoleculeReferences([fence(source)]);
	assert.deepEqual(references.map(item => [item.name, item.source.smiles]), [["Alcohol reagent", "CCO"], ["Elimination product", "C=C"]]);
	assert.ok(references.every(item => item.source.steps === undefined));
	assert.deepEqual(parseMoleculeReferences(references), references);
});

test("collection caps reference count and ignores invalid additional sources", () => {
	const sources = Array.from({ length: 40 }, (_, index) => ({ smiles: "C".repeat(index + 1) }));
	const references = collectMoleculeReferences([], sources);
	assert.equal(references.length, MAX_MOLECULE_REFERENCES);
	assert.deepEqual(collectMoleculeReferences([fence({ smiles: "C", label: "x".repeat(240) })]).map(item => [item.name.length, item.source.label?.length]), [[120, 240]]);
	assert.deepEqual(collectMoleculeReferences([], [{ smiles: "" }]), []);
});

test("collection never returns an over-budget reference bank", () => {
	const ket = JSON.stringify({ note: "x".repeat(400_000) });
	const references = collectMoleculeReferences([], [
		{ smiles: "CCO", ket }, { smiles: "CCN", ket: ket.replace("note", "second") }, { smiles: "CCC", ket: ket.replace("note", "third") }, { smiles: "CCF" },
	]);
	assert.deepEqual(references.map(item => item.source.smiles), ["CCO", "CCN", "CCF"]);
	assert.deepEqual(parseMoleculeReferences(references), references);
});

test("public context includes only current visible assistant prose and never reads hidden payloads", () => {
	const hidden = { get correctAnswer(): never { throw new Error("hidden answer must not be read"); } };
	const messages = [
		{ role: "assistant", parts: [
			{ type: "text", text: fence({ smiles: "CCCl", label: "Previous problem" }) },
			{ type: "tool-explain", toolCallId: "previous", state: "output-available", input: hidden },
			{ type: "text", text: fence({ smiles: "CCO", label: "Public starting molecule" }) },
			{ type: "reasoning", get text(): never { throw new Error("reasoning must not be read"); } },
			{ type: "tool-read", input: hidden, output: hidden },
			{ type: "tool-explain", toolCallId: "current", state: "input-available", input: hidden },
			{ type: "text", text: fence({ smiles: "CCBr", label: "After question" }) },
		] },
		{ role: "user", parts: [{ type: "text", text: fence({ smiles: "CCI" }) }] },
	];
	const context = publicChemistryContext(messages, "current");
	assert.deepEqual(collectMoleculeReferences(context).map(item => item.source.smiles), ["CCO"]);
	assert.deepEqual(publicChemistryContext(messages, "missing"), []);
});

test("public context uses the latest matching subject occurrence and skips failed retry boundaries", () => {
	const messages = [{ role: "assistant", parts: [
		{ type: "text", text: "Older problem text" },
		{ type: "tool-problem", toolCallId: "same-id", state: "input-available" },
		{ type: "text", text: "Current introduction" },
		{ type: "tool-explain", toolCallId: "failed-retry", state: "output-error" },
		{ type: "text", text: "Corrected public introduction" },
		{ type: "tool-problem", toolCallId: "same-id", state: "input-available" },
	] }];
	assert.deepEqual(publicChemistryContext(messages, "same-id"), ["Current introduction", "Corrected public introduction"]);
	messages[0]!.parts.push({ type: "tool-problem", toolCallId: "same-id", state: "input-streaming" });
	assert.deepEqual(publicChemistryContext(messages, "same-id"), [], "a partial replacement must not fall back to an earlier question");
});
