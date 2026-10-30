/** Curriculum canvas positions are isolated from reasoning-extraction layout.
 * The test uses a private data directory, never the user's graph. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { GraphNode, LearningContribution, Position } from "../src/core/contracts.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pos-commit-"));
process.env.LH_DATA_DIR = directory;
const legacyFile = path.join(directory, "graph", "positions.json");
const learningFile = path.join(directory, "graph", "learning-positions.json");
const legacyPositions = { n_a: { x: 100, y: 200 }, n_b: { x: 300, y: 400 }, n_c: { x: 500, y: 600 }, arg_chain1: { x: 350, y: 450 } };
let legacyBytes = "";
let commitPositions: (input: unknown) => Record<string, Position>;
let appendNode: (node: GraphNode) => void;
let saveContribution: (contribution: LearningContribution) => unknown;
const readPositions = () => JSON.parse(fs.readFileSync(learningFile, "utf8")).positions as Record<string, Position>;
const node = (id: string): GraphNode => ({ id, name: id, statement: `${id} statement`, aliases: [], createdAt: "2026-10-06T00:00:00.000Z", provenance: [] });

before(async () => {
	({ commitPositions } = await import("../src/server/commit-positions.ts"));
	const { stores } = await import("../src/server/stores.ts");
	({ saveLearningContribution: saveContribution } = await import("../src/server/learning-graph.ts"));
	appendNode = stores.graphStore.appendNode;
	for (const id of ["n_a", "n_b", "n_c"]) appendNode(node(id));
	stores.graphStore.appendChain({ id: "arg_chain1", premises: ["n_a", "n_b"], conclusion: "n_c", provenance: [], createdAt: "2026-10-06T00:00:00.000Z" });
	stores.graphStore.writePositions(legacyPositions);
	legacyBytes = fs.readFileSync(legacyFile, "utf8");
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("commitPositions for the learning graph", () => {
	it("keeps concept positions, rejects synthetic junctions, and never rewrites legacy layout", () => {
		const persisted = commitPositions({ n_a: { x: 10, y: 20 }, n_b: { x: 30, y: 40 }, n_c: { x: 50, y: 60 }, arg_chain1: { x: 34.5, y: 44.5 }, garbage_id: { x: 1, y: 1 } });
		assert.deepEqual(Object.keys(persisted).sort(), ["n_a", "n_b", "n_c"]);
		assert.deepEqual(readPositions(), persisted);
		assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
	});

	it("a full drag preserves every supplied coordinate without a settle", () => {
		const payload = { n_a: { x: 100, y: 200 }, n_b: { x: 300, y: 400 }, n_c: { x: 500, y: 600 } };
		commitPositions(payload);
		assert.deepEqual(readPositions(), payload);
		assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
	});

	it("partial drags retain omitted known positions and seed only new concepts", () => {
		appendNode(node("n_new"));
		const before = readPositions();
		commitPositions({ n_a: { x: 1, y: 2 } });
		const next = readPositions();
		assert.deepEqual(next.n_a, { x: 1, y: 2 });
		assert.deepEqual(next.n_b, before.n_b);
		assert.deepEqual(next.n_c, before.n_c);
		assert.ok(Number.isFinite(next.n_new!.x) && Number.isFinite(next.n_new!.y));
		assert.ok(!("arg_chain1" in next));
		const seed = next.n_new;
		commitPositions({ n_a: { x: 1, y: 2 } });
		assert.deepEqual(readPositions().n_new, seed, "an established seed never moves on a later commit");
	});

	it("accepts future curriculum concepts that are absent from the evidence ledger", () => {
		saveContribution({ sourceId: "curriculum", updatedAt: "2026-10-28T12:00:00.000Z", nodes: [], prerequisites: [], groups: [], futureNodes: [node("n_future_topic")] });
		const persisted = commitPositions({ n_future_topic: { x: 55, y: 77 } });
		assert.deepEqual(persisted.n_future_topic, { x: 55, y: 77 });
		assert.deepEqual(readPositions().n_future_topic, { x: 55, y: 77 });
		assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
	});

	it("invalid coordinates drop, excessive ones clamp, and empty input never writes", () => {
		const persisted = commitPositions({ n_a: { x: Number.NaN, y: 1 }, n_b: { x: 5, y: Number.POSITIVE_INFINITY }, n_c: { x: 1e9, y: 0 } });
		assert.ok(!("n_a" in persisted));
		assert.ok(!("n_b" in persisted));
		assert.equal(persisted.n_c!.x, 1e6);
		const bytes = fs.readFileSync(learningFile, "utf8");
		for (const input of [null, [], 3, { unknown: { x: 1, y: 2 } }]) assert.deepEqual(commitPositions(input), {});
		assert.equal(fs.readFileSync(learningFile, "utf8"), bytes);
	});
});
