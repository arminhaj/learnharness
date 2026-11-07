import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { KetSerializer, MolSerializer } from "ketcher-core";
import { moleculeMarkdown, type MoleculeDocument, type MoleculeSource } from "../src/core/chemistry.ts";
import { compactChemistryMessages, compactMoleculeForModel } from "../src/core/chemistry-model-context.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";
import { asAgentMessages, newThinkingMessage, toLlmMessages } from "../src/core/native-messages.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import { normalizeMolecule } from "../src/server/chemistry.ts";
import { curvedArrowsDocument, curvedArrowsKet } from "./fixtures/curved-arrows.ts";

type ContextSource = Record<string, unknown> & { steps?: ContextSource[] };

function projectedSource(text: string): ContextSource {
	const match = text.match(/```chemistry-context\n([\s\S]*?)\n```/);
	assert.ok(match, "large editable chemistry should use the model context representation");
	const payload = JSON.parse(match[1]!);
	assert.equal(payload.format, "chemistry-context-v1");
	assert.equal(typeof payload.molecule, "object");
	return payload.molecule as ContextSource;
}

function prettyDocument(): MoleculeDocument {
	return { ...curvedArrowsDocument, ket: JSON.stringify(JSON.parse(curvedArrowsKet), null, 2) };
}

function learner(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function messageText(message: Message): string {
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content;
	assert.ok(Array.isArray(content));
	return content.filter((block): block is { type: "text"; text: string } => block?.type === "text").map(block => block.text).join("\n");
}

test("chemistry context retains exact stereochemical, charged, isotope, and E/Z encodings", async () => {
	const sources: ContextSource[] = [];
	for (const smiles of ["C[C@H](O)CC", "C[C@@H](O)CC", "C[NH3+]", "[13CH3]CO", "C/C=C/C", "C/C=C\\C"]) {
		const normalized = await normalizeMolecule({ smiles });
		const ket = new KetSerializer().serialize(new MolSerializer().deserialize(normalized.molfile));
		const input = { ...normalized, ket: JSON.stringify(JSON.parse(ket), null, 2) };
		const compact = projectedSource(compactMoleculeForModel(input));
		assert.equal(compact.smiles, normalized.smiles, `SMILES must retain ${smiles}`);
		assert.equal(compact.molfile, normalized.molfile, "atom ordering, wedges, charges, and isotope records remain exact");
		assert.deepEqual(compact.ket, JSON.parse(input.ket));
		assert.equal((await normalizeMolecule({ molfile: compact.molfile as string })).smiles, normalized.smiles);
		sources.push(compact);
	}
	assert.notEqual(sources[0]!.smiles, sources[1]!.smiles, "enantiomers must remain distinct");
	assert.notEqual(sources[4]!.smiles, sources[5]!.smiles, "E/Z isomers must remain distinct");
});

test("full-head and fishhook arrows retain every coordinate and editor field", () => {
	const document = prettyDocument();
	const original = JSON.parse(document.ket!);
	const output = projectedSource(compactMoleculeForModel(document));
	assert.deepEqual(output.ket, original);
	assert.equal(output.molfile, document.molfile);
	const nodes = (output.ket as typeof original).root.nodes;
	assert.deepEqual(nodes.filter((node: { type?: string }) => node.type === "arrow").map((node: { data: unknown }) => node.data), [
		{ mode: "elliptical-arc-arrow-open-angle", pos: [{ x: 2, y: 0.3, z: 0 }, { x: 1, y: 0.3, z: 0 }], height: 0.7 },
		{ mode: "elliptical-arc-arrow-open-half-angle", pos: [{ x: 0, y: -0.3, z: 0 }, { x: 1, y: -0.3, z: 0 }], height: -0.6 },
	]);
});

test("unknown editor nodes and properties survive without a schema-dependent filter", () => {
	const document = prettyDocument();
	const editor = JSON.parse(document.ket!);
	editor.root.nodes.push({ type: "future-annotation", data: { literal: "C[C@@H]([O-])C", anchor: [0.25, -3.5], enabled: false, value: null } });
	editor.mol0.atoms[0].futureAtomProperty = { isotope: 13, charge: -1, values: [0, "", false] };
	const source = { ...document, ket: JSON.stringify(editor, null, 2) };
	assert.deepEqual(projectedSource(compactMoleculeForModel(source)).ket, editor);
});

test("nine synthesis steps retain order and exact sources with an unambiguous first-step reference", () => {
	const document = prettyDocument();
	const steps = Array.from({ length: 9 }, (_, index) => ({ ...document, id: `step-${index + 1}`, name: `Frame ${index + 1}`, label: `Drawing ${index + 1}` }));
	const source: MoleculeSource = { ...document, label: "Complete synthesis", caption: "Keep the intermediate order.", steps };
	const original = moleculeMarkdown(source);
	const model = compactMoleculeForModel(source);
	const output = projectedSource(model);
	assert.equal(output.firstStep, steps[0]!.id);
	assert.equal(output.label, source.label);
	assert.equal(output.caption, source.caption);
	for (const key of ["smiles", "molfile", "ket", "sdf"]) assert.equal(Object.hasOwn(output, key), false, `root ${key} is supplied by firstStep`);
	assert.deepEqual(output.steps?.map(step => [step.id, step.name, step.label]), steps.map(step => [step.id, step.name, step.label]));
	assert.equal(output.steps?.length, 9);
	for (let index = 0; index < steps.length; index++) {
		assert.equal(output.steps![index]!.molfile, steps[index]!.molfile);
		assert.equal(output.steps![index]!.smiles, steps[index]!.smiles);
		assert.deepEqual(output.steps![index]!.ket, JSON.parse(steps[index]!.ket!));
	}
	assert.ok(model.length < original.length * 0.65, "editor whitespace and escaped JSON should shrink without dropping chemistry");
});

test("projection reaches learner text, content blocks, and nested answer JSON without altering the answer", () => {
	const fence = moleculeMarkdown(prettyDocument());
	const answer = { kind: "explain", text: "My charge and arrow placement.", confidence: 3, molecule: fence, thinking: "Keep both steps." };
	const input: Message[] = [
		learner(`Before\n\n${fence}\n\nAfter`),
		{ role: "user", content: [{ type: "text", text: fence }, { type: "image", data: "fixture-image-data", mimeType: "image/png" }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "answer-1", toolName: "explain", content: [{ type: "text", text: JSON.stringify(answer) }], isError: false, timestamp: 3 },
	];
	const before = structuredClone(input);
	const output = compactChemistryMessages(input);
	assert.match(messageText(output[0]!), /^Before\n\n/);
	assert.match(messageText(output[0]!), /\n\nAfter$/);
	projectedSource(messageText(output[0]!));
	projectedSource(messageText(output[1]!));
	assert.deepEqual((output[1] as { content: unknown[] }).content[1], (input[1] as { content: unknown[] }).content[1]);
	const compactAnswer = JSON.parse(messageText(output[2]!));
	assert.deepEqual({ ...compactAnswer, molecule: fence }, answer);
	projectedSource(compactAnswer.molecule);
	assert.deepEqual(input, before, "the projection must not mutate the persisted native messages");
	assert.deepEqual(compactChemistryMessages(output), output, "reprojection is idempotent");
});

test("native conversion preserves the full editable history and portable transcript", () => {
	const document = prettyDocument();
	const message = newThinkingMessage("problem-1", "Check my electron flow.", undefined, document);
	const recordBefore = structuredClone(message);
	const exportBefore = sessionMarkdown([message]);
	const output = toLlmMessages(asAgentMessages([message]));
	const compact = projectedSource(messageText(output[0]!));
	assert.equal(compact.molfile, document.molfile);
	assert.deepEqual(compact.ket, JSON.parse(document.ket!));
	assert.deepEqual(message, recordBefore);
	assert.equal(sessionMarkdown([message]), exportBefore);
	assert.match(exportBefore, /```molecule/);
	assert.doesNotMatch(exportBefore, /chemistry-context/);
});

test("malformed, unsupported, unclosed, and already-small sources remain exact", () => {
	const malformedKet = "```molecule\n" + JSON.stringify({ ...prettyDocument(), ket: "{not-json" }) + "\n```";
	const cases = [
		malformedKet,
		"```molecule\n{not-json}\n```",
		"```molecule\n" + JSON.stringify({ ...prettyDocument(), version: 2 }) + "\n```",
		"```molecule\n" + JSON.stringify({ ...prettyDocument(), ket: "[]" }) + "\n```",
		"```molecule\n" + JSON.stringify(prettyDocument()),
		"```molecule\n{\"smiles\":\"[Na+].[O-]C[C@H](O)C\"}\n```",
		"```smiles\nC/C=C\\C\n```",
	];
	for (const text of cases) assert.deepEqual(compactChemistryMessages([learner(text)]), [learner(text)]);
});

test("assistant authorship, reasoning signatures, tool arguments, and system instructions are untouched", () => {
	const fence = moleculeMarkdown(prettyDocument());
	const input = [
		{ role: "system", content: fence, timestamp: 0 },
		{
			role: "assistant", api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
			content: [
				{ type: "thinking", thinking: fence, thinkingSignature: "opaque-provider-signature" },
				{ type: "text", text: fence, textSignature: "opaque-text-signature" },
				{ type: "toolCall", id: "call-1", name: "explain", arguments: { question: fence, molecule: prettyDocument() } },
			],
		},
	] as unknown as Message[];
	const before = structuredClone(input);
	assert.deepEqual(compactChemistryMessages(input), before);
	assert.deepEqual(input, before);
});

test("foreign content shapes keep the native converter's pass-through contract", () => {
	const messages = [
		{ role: "user", content: null, timestamp: 1 },
		{ role: "toolResult", toolCallId: "old", toolName: "read", timestamp: 2 },
		{ role: "user", content: [null, "foreign", { type: "text", text: null }], timestamp: 3 },
	] as unknown as Message[];
	assert.deepEqual(compactChemistryMessages(messages), messages);
});

test("unrepresentable editor and answer numbers fall back without rounding or changing their meaning", () => {
	for (const numericLiteral of ["9007199254740993", "1e400", "-0"]) {
		const ket = prettyDocument().ket!.replace(/\n}$/, `,\n  "futureNumericField": ${numericLiteral}\n}`);
		const fence = "```molecule\n" + JSON.stringify({ ...prettyDocument(), ket }) + "\n```";
		assert.deepEqual(compactChemistryMessages([learner(fence)]), [learner(fence)], `editor number ${numericLiteral} must remain in the original string`);
		const nestedAnswer = `{"kind":"explain","futureNumericField":${numericLiteral},"molecule":${JSON.stringify(moleculeMarkdown(prettyDocument()))}}`;
		assert.deepEqual(compactChemistryMessages([learner(nestedAnswer)]), [learner(nestedAnswer)], `answer number ${numericLiteral} must remain in the original string`);
	}
});

test("a conflicting synthetic firstStep property keeps the original synthesis", () => {
	const document = prettyDocument();
	const source = { ...document, firstStep: "existing-unknown-metadata", steps: [{ ...document, id: "frame-1", name: "First frame" }] };
	const fence = "```molecule\n" + JSON.stringify(source) + "\n```";
	assert.deepEqual(compactChemistryMessages([learner(fence)]), [learner(fence)]);
});

test("multiple complete fence styles compact independently while surrounding text stays exact", () => {
	const source = JSON.stringify(prettyDocument());
	const first = "~~~molecule\r\n" + source + "\r\n~~~";
	const second = "````molecule\n" + source + "\n````";
	const text = `Literal before.\r\n${first}\r\nBetween structures: [O-].\n${second}\nLiteral after.`;
	const output = messageText(compactChemistryMessages([learner(text)])[0]!);
	assert.equal([...output.matchAll(/```chemistry-context\n/g)].length, 2);
	assert.ok(output.startsWith("Literal before.\r\n"));
	assert.ok(output.includes("\r\nBetween structures: [O-].\n"));
	assert.ok(output.endsWith("\nLiteral after."));
});

test("request chemistry projection honors the existing history compaction cutoff", () => {
	const older = newThinkingMessage("problem-old", "Superseded earlier answer.", undefined, { ...prettyDocument(), label: "Superseded drawing" });
	const current = newThinkingMessage("problem-new", "Current answer to check.", undefined, prettyDocument());
	const marker = newCompactionMarker("The earlier problem is complete.", { firstKeptMessageId: current.id, tokensBefore: 160_000, at: "2026-11-06T12:00:00Z" });
	const messages = [older, current, marker];
	const before = structuredClone(messages);
	const output = toLlmMessages(asAgentMessages(messages));
	const modelText = output.map(messageText).join("\n");
	assert.match(modelText, /The earlier problem is complete/);
	assert.match(modelText, /Current answer to check/);
	assert.doesNotMatch(modelText, /Superseded earlier answer|Superseded drawing/);
	projectedSource(modelText);
	assert.deepEqual(messages, before);
});
