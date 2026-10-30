import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runInNewContext } from "node:vm";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import Molecule3D from "../components/chemistry/molecule-3d.tsx";
import { viewerFrameHtml } from "../components/chemistry/viewer-frame.ts";
import type { ConformerResult, MoleculeSource } from "../src/core";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, "location", { configurable: true, value: { origin: "http://localhost" } });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const requests: Record<string, unknown>[] = [];

type Message = { channel: string; type: string; modelId?: string; sdf?: string; style?: string; group?: number; [key: string]: unknown };
type Frame = { window: { postMessage: (message: Message) => void }; messages: Message[]; channel: string };

function ensemble(prefix = "sample"): ConformerResult {
	return {
		sdf: `${prefix}-lowest`, generated: true,
		// Deliberately unordered: default/labels must follow energy ranking.
		conformers: [
			{ id: `${prefix}-high`, sdf: `${prefix}-high-geometry`, energy: 3.8, relativeEnergy: 5.2, rings: [{ atomIndices: [0, 1, 2, 3, 4, 5], shape: "non-chair", theta: 88, amplitude: 0.6, torsions: [] }] },
			{ id: `${prefix}-low`, sdf: `${prefix}-lowest`, energy: -1.4, relativeEnergy: 0, rings: [{ atomIndices: [0, 1, 2, 3, 4, 5], shape: "chair", theta: 3, amplitude: 0.56, torsions: [], chairBasin: "positive" }] },
		],
		search: { method: "MMFF94", requested: 24, embedded: 22, converged: 21, stereoRejected: 0, unique: 2, returned: 2, rmsdThreshold: 0.35, energyUnit: "kcal/mol", exhaustive: false, seed: 42, stereochemistry: "specified", isomericSmiles: "C1CCCCC1" },
	};
}

function mockFetch(respond: (body: Record<string, unknown>) => Response | Promise<Response>) {
	globalThis.fetch = async (_url, options) => {
		const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
		requests.push(body);
		return respond(body);
	};
}

async function mount(source: MoleculeSource) {
	host = document.createElement("div"); document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<Molecule3D source={source} />));
	return host;
}

async function connectFrame(): Promise<Frame> {
	const iframe = host!.querySelector("iframe")!;
	const messages: Message[] = [];
	const frameWindow = { postMessage: (message: Message) => messages.push(message) };
	Object.defineProperty(iframe, "contentWindow", { configurable: true, value: frameWindow });
	await act(async () => iframe.dispatchEvent(new window.Event("load")));
	const channel = messages.find(message => message.type === "hello")!.channel;
	const frame = { window: frameWindow, messages, channel };
	await emit(frame, { type: "ready" });
	return frame;
}

async function emit(frame: Frame, message: Partial<Message>) {
	await act(async () => {
		const event = new window.Event("message");
		Object.assign(event, { source: frame.window, data: { channel: frame.channel, ...message } });
		window.dispatchEvent(event);
	});
}

function latestModel(frame: Frame) { return frame.messages.filter(message => message.type === "model").at(-1)!; }
function button(text: string) { return [...host!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!; }
async function selectConformer(id: string) {
	const select = host!.querySelector<HTMLSelectElement>("select")!;
	// Linkedom exposes a getter-only select value; the native change event is
	// otherwise the real React state path exercised in the browser.
	Object.defineProperty(select, "value", { configurable: true, writable: true, value: id });
	await act(async () => select.dispatchEvent(new window.Event("change", { bubbles: true })));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
	requests.length = 0;
});

test("the selector loads lowest-found geometry and changes both geometry and energy metadata", async () => {
	mockFetch(() => Response.json(ensemble()));
	await mount({ smiles: "C1CCCCC1" });
	const frame = await connectFrame();
	const lowest = latestModel(frame);
	assert.equal(lowest.sdf, "sample-lowest");
	assert.match(host!.querySelector("option")!.textContent!, /1 · lowest found · ΔE 0.00 kcal\/mol · chair/);
	assert.match(host!.querySelector('[data-testid="conformer-details"]')!.textContent!, /MMFF94 · ΔE 0.00 kcal\/mol · chair/);
	assert.match(host!.textContent!, /22\/24 samples embedded · 21 converged · 2 distinct · 2 shown/);
	assert.match(host!.textContent!, /not free energies or conformer populations/);
	await emit(frame, { type: "rendered", modelId: lowest.modelId });
	assert.equal(button("Rotate left").disabled, false);
	await act(async () => button("Sticks").click());
	await selectConformer("sample-high");
	const higher = latestModel(frame);
	assert.equal(higher.sdf, "sample-high-geometry");
	assert.equal(higher.style, "sticks", "conformer switching preserves the chosen representation");
	assert.notEqual(higher.modelId, lowest.modelId);
	assert.equal(higher.group, lowest.group, "the frame can retain the camera within this search");
	assert.match(host!.querySelector('[data-testid="conformer-details"]')!.textContent!, /ΔE 5.20 kcal\/mol · non-chair/);
	assert.equal(button("Rotate left").disabled, true, "new model waits for its own render acknowledgement");
	await emit(frame, { type: "rendered", modelId: lowest.modelId });
	await emit(frame, { type: "error", modelId: lowest.modelId, error: "stale geometry error" });
	assert.equal(button("Rotate left").disabled, true);
	assert.equal(host!.querySelector('[role="alert"]'), null);
	await emit(frame, { type: "rendered", modelId: higher.modelId });
	assert.equal(button("Rotate left").disabled, false);
	const count = frame.messages.filter(message => message.type === "model").length;
	await act(async () => button("Rotate left").click());
	assert.equal(frame.messages.at(-1)!.type, "rotate");
	assert.equal(frame.messages.at(-1)!.modelId, higher.modelId);
	assert.equal(frame.messages.filter(message => message.type === "model").length, count, "rotation never changes the selected conformer");
});

test("changing molecular source resets selection and ignores the previous model's messages", async () => {
	mockFetch(body => Response.json(ensemble(body.smiles === "CCCC" ? "butane" : "ring")));
	await mount({ smiles: "C1CCCCC1" });
	const frame = await connectFrame();
	await selectConformer("ring-high");
	const oldModel = latestModel(frame);
	await act(async () => root!.render(<Molecule3D source={{ smiles: "CCCC" }} />));
	const model = latestModel(frame);
	assert.equal(model.sdf, "butane-lowest");
	assert.notEqual(model.group, oldModel.group);
	await emit(frame, { type: "error", modelId: oldModel.modelId, error: "old source" });
	await emit(frame, { type: "rendered", modelId: oldModel.modelId });
	assert.equal(host!.querySelector('[role="alert"]'), null);
	assert.equal(button("Rotate right").disabled, true);
	assert.match(host!.querySelector('[data-testid="conformer-details"]')!.textContent!, /ΔE 0.00/);
	assert.equal(requests.length, 2);
});

test("an imported model remains unranked until an explicit conformer search", async () => {
	mockFetch(body => Response.json(body.search ? ensemble("searched") : { sdf: "imported-coordinates", generated: false }));
	await mount({ sdf: "source-sdf", label: "Imported ring" });
	const frame = await connectFrame();
	assert.equal(latestModel(frame).sdf, "imported-coordinates");
	assert.equal(host!.querySelector("select"), null);
	assert.doesNotMatch(host!.textContent!, /ΔE|kcal\/mol|lowest found/);
	assert.match(host!.textContent!, /energy not evaluated/);
	assert.equal(requests[0]!.search, undefined);
	await act(async () => button("Search conformers").click());
	assert.deepEqual(requests[1], { sdf: "source-sdf", label: "Imported ring", search: true });
	assert.equal(latestModel(frame).sdf, "searched-lowest");
	assert.ok(host!.querySelector("select"));
	await act(async () => button("Show imported coordinates").click());
	assert.equal(requests[2]!.search, undefined);
	assert.equal(latestModel(frame).sdf, "imported-coordinates");
	assert.doesNotMatch(host!.textContent!, /ΔE|kcal\/mol/);
});

test("empty ring validation never invents a chair label and selector keys remain local", async () => {
	const result = ensemble();
	result.conformers!.forEach(candidate => { candidate.rings = []; });
	mockFetch(() => Response.json(result));
	await mount({ smiles: "CCCC" });
	assert.doesNotMatch(host!.querySelector("select")!.textContent!, /chair|near-planar/);
	let escapedKeys = 0;
	const listener = () => escapedKeys++;
	window.addEventListener("keydown", listener);
	try {
		await act(async () => host!.querySelector("select")!.dispatchEvent(new window.Event("keydown", { bubbles: true, cancelable: true })));
		assert.equal(escapedKeys, 0);
	} finally { window.removeEventListener("keydown", listener); }
});

test("search intent resets when switching imported sources, including returning to the old source", async () => {
	mockFetch(body => Response.json(body.search ? ensemble() : { sdf: body.sdf, generated: false }));
	await mount({ sdf: "first-import" });
	await act(async () => button("Search conformers").click());
	assert.equal(requests.at(-1)!.search, true);
	await act(async () => root!.render(<Molecule3D source={{ sdf: "second-import" }} />));
	assert.equal(requests.at(-1)!.sdf, "second-import");
	assert.equal(requests.at(-1)!.search, undefined);
	await act(async () => root!.render(<Molecule3D source={{ sdf: "first-import" }} />));
	assert.equal(requests.at(-1)!.sdf, "first-import");
	assert.equal(requests.at(-1)!.search, undefined);
	assert.match(host!.textContent!, /energy not evaluated/);
});

test("a late response from an aborted source cannot replace the current search", async () => {
	let resolveFirst!: (response: Response) => void;
	mockFetch(body => body.smiles === "old" ? new Promise(resolve => { resolveFirst = resolve; }) : Response.json(ensemble("new")));
	await mount({ smiles: "old" });
	const frame = await connectFrame();
	await act(async () => root!.render(<Molecule3D source={{ smiles: "new" }} />));
	assert.equal(latestModel(frame).sdf, "new-lowest");
	await act(async () => resolveFirst(Response.json(ensemble("old"))));
	assert.equal(latestModel(frame).sdf, "new-lowest");
	assert.doesNotMatch(host!.querySelector("select")!.innerHTML, /old-/);
});

test("failed imported searches can retry with search intent preserved", async () => {
	let searches = 0;
	mockFetch(body => {
		if (!body.search) return Response.json({ sdf: "imported", generated: false });
		return ++searches === 1 ? Response.json({ error: "Search timed out" }, { status: 503 }) : Response.json(ensemble("retry"));
	});
	await mount({ sdf: "imported-source" });
	await connectFrame();
	await act(async () => button("Search conformers").click());
	assert.match(host!.querySelector('[role="alert"]')!.textContent!, /Search timed out/);
	await act(async () => button("Try again").click());
	const retriedFrame = await connectFrame();
	assert.equal(requests.at(-1)!.search, true);
	assert.equal(latestModel(retriedFrame).sdf, "retry-lowest");
	assert.equal(host!.querySelector('[role="alert"]'), null);
});

test("iframe protocol loads selected geometry, preserves camera within an ensemble, and correlates replies", () => {
	const replies: Message[] = [];
	const geometries: string[] = [];
	const rotations: unknown[][] = [];
	const views: unknown[] = [];
	let receive: (event: { source: unknown; data: unknown }) => void;
	const parent = { postMessage: (message: Message) => replies.push(message) };
	const camera = [0, 0, 0, 30, 1, 0, 0, 0];
	const viewer = {
		clear() {}, setBackgroundColor() {}, setStyle() {}, render() {}, zoomTo() {}, resize() {}, zoom() {},
		getView: () => camera, setView: (view: unknown) => views.push(view),
		rotate: (...args: unknown[]) => rotations.push(args),
		addModel: (sdf: string) => { if (sdf === "broken") throw new Error("Bad geometry"); geometries.push(sdf); return { selectedAtoms: () => [{}] }; },
	};
	const frame = viewerFrameHtml("http://localhost/chemistry/3Dmol-min.js", "test-channel");
	const script = /<script>([\s\S]*?)<\/script>/.exec(frame)![1]!;
	runInNewContext(script, {
		parent, document: { getElementById: () => ({}) },
		window: { $3Dmol: { createViewer: () => viewer }, addEventListener: (_name: string, listener: typeof receive) => { receive = listener; } },
	});
	const send = (data: Record<string, unknown>) => receive!({ source: parent, data: { channel: "test-channel", ...data } });
	send({ type: "model", modelId: "first", group: 1, sdf: "chair-coordinates", style: "balls" });
	send({ type: "model", modelId: "second", group: 1, sdf: "other-coordinates", style: "sticks" });
	assert.deepEqual(geometries, ["chair-coordinates", "other-coordinates"]);
	assert.equal(views.length, 1);
	assert.equal(views[0], camera);
	assert.deepEqual(replies.filter(message => message.type === "rendered").map(message => message.modelId), ["first", "second"]);
	send({ type: "rotate", modelId: "first", axis: "y", angle: 30 });
	assert.equal(rotations.length, 0, "a queued command for the previous geometry cannot rotate this one");
	send({ type: "rotate", modelId: "second", axis: "y", angle: 30 });
	assert.deepEqual(rotations, [[30, "y"]]);
	send({ type: "model", modelId: "third", group: 2, sdf: "new-molecule", style: "balls" });
	assert.equal(views.length, 1, "a new source/search gets its own framing");
	send({ type: "model", modelId: "bad", group: 2, sdf: "broken" });
	assert.equal(replies.at(-1)!.type, "error");
	assert.equal(replies.at(-1)!.modelId, "bad");
});
