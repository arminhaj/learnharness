import assert from "node:assert/strict";
import test from "node:test";
import { ChemicalNameSearchError, chemistryNameSearchResponse, searchChemicalNames } from "../src/server/chemical-name-search.ts";

const sulfuricAcid = { CID: 1118, Title: "Sulfuric Acid", MolecularFormula: "H2O4S", SMILES: "OS(=O)(=O)O" };
const properties = (rows: unknown[] = [sulfuricAcid]) => Response.json({ PropertyTable: { Properties: rows } });
const request = (payload: unknown) => new Request("http://localhost/api/chemistry/search", { method: "POST", body: JSON.stringify(payload) });
const errorStatus = (status: number) => (error: unknown) => error instanceof ChemicalNameSearchError && error.status === status;

test("chemical name lookup posts an encoded exact name and returns insertion data", async () => {
	const results = await searchChemicalNames("  sulfuric acid  ", { fetch: async (input, init) => {
		assert.equal(input, "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/property/Title,MolecularFormula,SMILES/JSON?name_type=complete");
		assert.equal(init?.method, "POST");
		assert.equal(new Headers(init?.headers).get("content-type"), "application/x-www-form-urlencoded");
		assert.equal(new URLSearchParams(init?.body as string).get("name"), "sulfuric acid");
		assert.equal(init?.cache, "no-store");
		assert.ok(init?.signal instanceof AbortSignal);
		return properties();
	} });
	assert.deepEqual(results, [{ cid: 1118, title: "Sulfuric Acid", formula: "H2O4S", smiles: "OS(=O)(=O)O" }]);
});

test("lookup preserves stereochemical SMILES, escapes reserved name characters, and caps distinct results", async () => {
	const stereo = "[13CH3][C@H](O)/C=C/[NH3+]";
	const rows = Array.from({ length: 7 }, (_, index) => ({ ...sulfuricAcid, CID: index + 1, SMILES: stereo }));
	rows.splice(1, 0, rows[0]!);
	const results = await searchChemicalNames("(R)-name/with & symbols+", { fetch: async (_input, init) => {
		assert.equal(new URLSearchParams(init?.body as string).get("name"), "(R)-name/with & symbols+");
		return properties(rows);
	} });
	assert.deepEqual(results.map(result => result.cid), [1, 2, 3, 4, 5]);
	assert.ok(results.every(result => result.smiles === stereo));
});

test("invalid names are rejected before any external request", async () => {
	for (const value of [undefined, null, 42, {}, [], "", "   ", "C".repeat(301), "acid\0", "acid\nbase"]) {
		await assert.rejects(searchChemicalNames(value, { fetch: async () => { assert.fail("invalid names must not be fetched"); } }), errorStatus(400));
	}
});

test("name search reports no match for PubChem 404 and empty result lists", async () => {
	for (const response of [Response.json({ Fault: { Code: "PUGREST.NotFound" } }, { status: 404 }), properties([])]) {
		await assert.rejects(searchChemicalNames("not a compound", { fetch: async () => response }), errorStatus(404));
	}
});

test("malformed upstream structures fail without returning partial insertion data", async () => {
	for (const response of [
		new Response("<html>unexpected response</html>"),
		Response.json({}),
		properties([null]),
		properties([{ ...sulfuricAcid, CID: -1 }]),
		properties([{ ...sulfuricAcid, SMILES: "" }]),
		properties([{ ...sulfuricAcid, SMILES: "CCO ethanol" }]),
		properties([{ ...sulfuricAcid, MolecularFormula: "" }]),
		properties([{ ...sulfuricAcid, Title: "" }]),
		properties([sulfuricAcid, { ...sulfuricAcid, SMILES: null }]),
		new Response(" ".repeat(500_001)),
	]) {
		await assert.rejects(searchChemicalNames("sulfuric acid", { fetch: async () => response }), errorStatus(502));
	}
});

test("PubChem service errors and offline failures stay distinct from no match", async () => {
	for (const status of [429, 503]) {
		await assert.rejects(searchChemicalNames("sulfuric acid", { fetch: async () => new Response("<html>busy</html>", { status }) }), errorStatus(503));
	}
	await assert.rejects(searchChemicalNames("sulfuric acid", { fetch: async () => new Response("failed", { status: 500 }) }), errorStatus(502));
	await assert.rejects(searchChemicalNames("sulfuric acid", { fetch: async () => { throw new TypeError("raw network details"); } }), (error: unknown) => {
		assert.ok(error instanceof ChemicalNameSearchError);
		assert.equal(error.status, 503);
		assert.match(error.message, /internet connection/);
		assert.doesNotMatch(error.message, /raw network details/);
		return true;
	});
});

test("name lookup aborts the external fetch when its timeout expires", async () => {
	let aborted = false;
	await assert.rejects(searchChemicalNames("sulfuric acid", { timeoutMs: 5, fetch: async (_input, init) => new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
	}) }), (error: unknown) => error instanceof ChemicalNameSearchError && error.status === 503 && /took too long/.test(error.message));
	assert.equal(aborted, true);
});

test("a cancelled editor request also aborts the external lookup", async () => {
	const controller = new AbortController();
	let upstreamSignal: AbortSignal | null | undefined;
	const pending = searchChemicalNames("sulfuric acid", { signal: controller.signal, fetch: async (_input, init) => {
		upstreamSignal = init?.signal;
		return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
	} });
	controller.abort();
	await assert.rejects(pending, errorStatus(503));
	assert.equal(upstreamSignal?.aborted, true);
});

test("search HTTP handler validates JSON and bounded request bodies", async () => {
	for (const payload of [{}, [], null, { query: 42 }, { query: "" }]) {
		assert.equal((await chemistryNameSearchResponse(request(payload))).status, 400);
	}
	for (const body of ["invalid json", " ".repeat(4_097)]) {
		assert.equal((await chemistryNameSearchResponse(new Request("http://localhost/api/chemistry/search", { method: "POST", body }))).status, 400);
	}
});

test("search HTTP handler exposes the result contract and actionable failures", async t => {
	t.mock.method(globalThis, "fetch", async () => properties());
	const success = await chemistryNameSearchResponse(request({ query: "sulfuric acid" }));
	assert.equal(success.status, 200);
	assert.deepEqual(await success.json(), { results: [{ cid: 1118, title: "Sulfuric Acid", formula: "H2O4S", smiles: "OS(=O)(=O)O" }] });
	t.mock.method(globalThis, "fetch", async () => new Response("not found", { status: 404 }));
	const noResult = await chemistryNameSearchResponse(request({ query: "unknown chemical" }));
	assert.equal(noResult.status, 404);
	assert.match((await noResult.json()).error, /No compound/);
	t.mock.method(globalThis, "fetch", async () => new Response("<html>busy</html>", { status: 503 }));
	const busy = await chemistryNameSearchResponse(request({ query: "sulfuric acid" }));
	assert.equal(busy.status, 503);
	assert.match((await busy.json()).error, /PubChem is busy/);
});
