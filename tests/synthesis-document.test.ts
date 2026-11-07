import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_SYNTHESIS_STEPS, moleculeMarkdown, parseMoleculeBlock, parseMoleculeDocument, parseMoleculeSource,
	type MoleculeDocument,
} from "../src/core/chemistry.ts";
import { parseChatInput } from "../src/core/input-events.ts";
import { asAgentMessages, newThinkingMessage, toLlmMessages } from "../src/core/native-messages.ts";
import { buildAnswer, compactAnswerForModel, type QuestionData } from "../src/core/question-core.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import { chemistryNormalizeResponse, normalizeMolecule, normalizeMoleculeDocument } from "../src/server/chemistry.ts";
import { curvedArrowsDocument, curvedArrowsKet, ethanolKet } from "./fixtures/curved-arrows.ts";

const ethanol = await normalizeMolecule({ smiles: "CCO" });
const ethene = await normalizeMolecule({ smiles: "C=C" });

function synthesis(): MoleculeDocument {
	return {
		...ethanol, label: "Your structure",
		steps: [
			{ ...ethanol, id: "starting-material", name: "Starting material", label: "Ethanol" },
			{ ...ethene, id: "product", name: "Elimination product" },
		],
	};
}

test("legacy molecular documents and fences keep their existing shape", async () => {
	assert.deepEqual(parseMoleculeDocument(ethanol), ethanol);
	assert.deepEqual(await normalizeMoleculeDocument(ethanol), ethanol);
	const fence = moleculeMarkdown(ethanol);
	assert.deepEqual(parseMoleculeBlock(fence.split("\n")[1]!), ethanol);
	assert.equal(parseMoleculeSource({ smiles: "CCO" }).steps, undefined);
});

test("all synthesis steps retain order, identity, metadata, and independent chemistry", async () => {
	const input = synthesis();
	assert.deepEqual(parseMoleculeDocument(input), input);
	const parsedSource = parseMoleculeSource({ ...input, caption: "Overall synthesis", steps: input.steps!.map((step, index) => ({ ...step, caption: `Scene ${index + 1}` })) });
	assert.equal(parsedSource.caption, "Overall synthesis");
	assert.equal(parsedSource.steps?.[0]?.caption, "Scene 1");
	const saved = await normalizeMoleculeDocument(input);
	assert.deepEqual(saved.steps?.map(step => [step.id, step.name, step.smiles]), [
		["starting-material", "Starting material", "CCO"],
		["product", "Elimination product", "C=C"],
	]);
	assert.equal(saved.label, "Your structure");
	assert.equal(saved.steps?.[0]?.label, "Ethanol");
	assert.equal(saved.molfile, saved.steps?.[0]?.molfile);
	assert.equal(saved.smiles, saved.steps?.[0]?.smiles);
	assert.deepEqual(parseMoleculeBlock(moleculeMarkdown(saved).split("\n")[1]!), saved);
});

test("a single named step keeps its tab identity and every source step can be normalized", async () => {
	const result = await normalizeMolecule({ smiles: "CCO", steps: [{ smiles: "CCO", id: "only-step", name: "Initial alcohol" }] });
	assert.equal(result.steps?.length, 1);
	assert.equal(result.steps[0]?.id, "only-step");
	assert.equal(result.steps[0]?.name, "Initial alcohol");
	assert.deepEqual(parseMoleculeDocument(result), result);
});

test("each step uses its authoritative Molfile and rejects invalid later chemistry", async () => {
	const staleSmiles = synthesis();
	staleSmiles.steps![1]!.smiles = "CC(=O)O";
	assert.equal((await normalizeMoleculeDocument(staleSmiles)).steps?.[1]?.smiles, "C=C");
	const invalidLater = synthesis();
	invalidLater.steps![1]!.molfile = "broken molecule";
	await assert.rejects(normalizeMoleculeDocument(invalidLater), /Step 2 \(Elimination product\).*could not be read/);
	const response = await chemistryNormalizeResponse(new Request("http://localhost/api/chemistry/normalize", { method: "POST", body: JSON.stringify(invalidLater) }));
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /Step 2/);
});

test("electron-flow arrows are preserved and independently validated on every step", async () => {
	const input: MoleculeDocument = {
		...curvedArrowsDocument,
		steps: [
			{ ...curvedArrowsDocument, id: "arrows-1", name: "Electron flow" },
			{ ...curvedArrowsDocument, id: "arrows-2", name: "Next electron flow" },
		],
	};
	const saved = await normalizeMoleculeDocument(input);
	assert.equal(saved.ket, curvedArrowsKet);
	assert.ok(saved.steps?.every(step => step.ket === curvedArrowsKet));
	assert.deepEqual(parseMoleculeBlock(moleculeMarkdown(saved).split("\n")[1]!), saved);
	const mismatch = synthesis();
	mismatch.steps![1]!.ket = ethanolKet;
	await assert.rejects(normalizeMoleculeDocument(mismatch), /Step 2.*drawing does not match/);
});

test("synthesis parser rejects nested, empty, excessive, duplicate, and incomplete steps", () => {
	const source = synthesis();
	for (const steps of [[], "not an array", Array.from({ length: MAX_SYNTHESIS_STEPS + 1 }, (_, index) => ({ ...ethanol, id: `step-${index}`, name: `Step ${index + 1}` }))]) {
		assert.throws(() => parseMoleculeSource({ ...source, steps }), /between 1 and 12 complete steps/);
	}
	assert.throws(() => parseMoleculeSource({ ...source, steps: [{ ...source.steps![0], steps: [] }] }), /nested steps/);
	assert.throws(() => parseMoleculeSource({ ...source, steps: [source.steps![0], { ...source.steps![1], id: "starting-material" }] }), /unique ID/);
	assert.throws(() => parseMoleculeSource({ ...source, steps: [{ ...source.steps![0], id: "" }] }), /unique ID/);
	assert.throws(() => parseMoleculeSource({ ...source, steps: [{ ...source.steps![0], id: "unsafe/id" }] }), /unique ID/);
	assert.throws(() => parseMoleculeSource({ ...source, steps: [{ ...source.steps![0], name: " " }] }), /Name each synthesis step/);
	assert.throws(() => parseMoleculeSource({ ...source, steps: [{ ...source.steps![0], name: "x".repeat(121) }] }), /120 characters/);
	assert.throws(() => parseMoleculeSource({ ...source, steps: [source.steps![0], { id: "empty", name: "Empty step" }] }), /Add a SMILES/);
	assert.throws(() => parseMoleculeDocument({ ...source, steps: [source.steps![0], { id: "incomplete", name: "Incomplete", smiles: "CCO" }] }), /version 1, Molfile, and SMILES/);
});

test("root chemistry must mirror the first step while root labels may differ", () => {
	const source = synthesis();
	for (const change of [{ smiles: "CC" }, { molfile: "other Molfile" }, { ket: ethanolKet }, { sdf: "other SDF" }]) {
		assert.throws(() => parseMoleculeDocument({ ...source, ...change }), /mirror its first step/);
	}
	assert.equal(parseMoleculeDocument(source).label, "Your structure");
});

test("synthesis payloads retain per-step bounds and enforce one aggregate byte budget", () => {
	const source = synthesis();
	assert.throws(() => parseMoleculeSource({ ...source, steps: [source.steps![0], { ...source.steps![1], smiles: "C".repeat(16_001) }] }), /oversized molecule smiles/);
	const ket = JSON.stringify({ note: "x".repeat(400_000) });
	assert.throws(() => parseMoleculeSource({
		...ethanol, ket,
		steps: [{ ...ethanol, ket, id: "first", name: "First" }, { ...ethanol, ket, id: "second", name: "Second" }],
	}), /all steps together under 1 MB/);
	const unicodeKet = JSON.stringify({ note: "\uD83D\uDE00".repeat(240_000) });
	assert.throws(() => parseMoleculeSource({ ...ethanol, ket: unicodeKet, steps: [{ ...ethanol, ket: unicodeKet, id: "first", name: "First" }] }), /all steps together under 1 MB/);
});

test("all steps reach tutor context and portable export without mutating older attempts", () => {
	const draft = synthesis();
	const input = parseChatInput({ type: "thinking", problemCallId: "problem-1", text: "My synthesis", molecule: draft });
	assert.equal(input.type, "thinking");
	assert.equal(input.type === "thinking" && input.molecule?.steps?.length, 2);
	const message = newThinkingMessage("problem-1", "My synthesis", undefined, draft);
	const question: QuestionData = { id: "question-1", kind: "explain", question: "Draw the sequence", mode: "text", options: [], createdAt: "2026-11-05T00:00:00Z" };
	const answer = buildAnswer(question, { molecule: draft });
	draft.steps![1]!.name = "Changed later";
	draft.steps![1]!.smiles = "wrong later mutation";
	draft.steps!.push({ ...ethanol, id: "later-step", name: "Extra later step" });
	const snapshot = (message.details as { molecule: MoleculeDocument }).molecule;
	assert.equal(snapshot.steps?.length, 2);
	assert.equal(snapshot.steps?.[1]?.name, "Elimination product");
	assert.equal(snapshot.steps?.[1]?.smiles, "C=C");
	assert.equal(answer.molecule?.steps?.length, 2);
	assert.equal(answer.molecule?.steps?.[1]?.name, "Elimination product");
	assert.equal(answer.molecule?.steps?.[1]?.smiles, "C=C");
	for (const serialized of [JSON.stringify(toLlmMessages(asAgentMessages([message]))), sessionMarkdown([message]), String(compactAnswerForModel(answer).molecule)]) {
		assert.match(serialized, /starting-material/);
		assert.match(serialized, /Elimination product/);
		assert.match(serialized, /C=C/);
		assert.doesNotMatch(serialized, /Changed later|Extra later step|wrong later mutation/);
	}
});
