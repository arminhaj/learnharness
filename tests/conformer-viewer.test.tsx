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
function labeledButton(label: string) { return [...host!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label)!; }
function conformerRow(id: string) { return [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(row => row.dataset.conformerId === id)!; }
async function selectConformer(id: string) {
	await act(async () => conformerRow(id).click());
}
async function pressConformerKey(id: string, key: string) {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key });
	await act(async () => conformerRow(id).dispatchEvent(event));
	return event;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
	requests.length = 0;
});

test("the sidebar sorts conformers by energy and changes both geometry and energy metadata", async () => {
	mockFetch(() => Response.json(ensemble()));
	await mount({ smiles: "C1CCCCC1" });
	const frame = await connectFrame();
	const lowest = latestModel(frame);
	assert.equal(lowest.sdf, "sample-lowest");
	const rows = [...host!.querySelectorAll('[role="radio"]')];
	assert.deepEqual(rows.map(row => row.textContent), ["ΔE 0.00chair", "ΔE 5.20non-chair"]);
	assert.equal(rows[0]!.getAttribute("aria-checked"), "true");
	assert.equal(rows[1]!.getAttribute("aria-checked"), "false");
	assert.equal(labeledButton("Collapse conformers").getAttribute("aria-expanded"), "true");
	assert.equal(host!.querySelector("select"), null);
	assert.doesNotMatch(host!.querySelector('[role="radiogroup"]')!.textContent!, /kcal\/mol|MMFF94|lowest found/);
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
	assert.equal(conformerRow("sample-high").getAttribute("aria-checked"), "true");
	assert.equal(conformerRow("sample-low").getAttribute("aria-checked"), "false");
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

test("collapsing and reopening preserves the iframe, selected model, and render state", async () => {
	mockFetch(() => Response.json(ensemble()));
	await mount({ smiles: "C1CCCCC1" });
	const frame = await connectFrame();
	await selectConformer("sample-high");
	const model = latestModel(frame);
	await emit(frame, { type: "rendered", modelId: model.modelId });
	const iframe = host!.querySelector("iframe");
	const count = frame.messages.length;
	const activeElementDescriptor = Object.getOwnPropertyDescriptor(document, "activeElement");
	const toggle = labeledButton("Collapse conformers");
	let focusedToggle = false;
	toggle.focus = () => { focusedToggle = true; };
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => conformerRow("sample-high") });
	try {
		await act(async () => toggle.click());
		assert.equal(focusedToggle, true, "focus moves out of the hidden list to its visible toggle");
		assert.equal(labeledButton("Expand conformers").getAttribute("aria-expanded"), "false");
		assert.equal(host!.querySelector<HTMLElement>('[role="radiogroup"]')!.hidden, true);
		assert.equal(host!.querySelector("iframe"), iframe);
		assert.equal(host!.querySelector("iframe")!.contentWindow, frame.window);
		assert.equal(button("Rotate left").disabled, false);
		assert.match(host!.querySelector('[data-testid="conformer-sidebar"]')!.className, /sm:w-10/);
		await act(async () => labeledButton("Expand conformers").click());
		assert.equal(labeledButton("Collapse conformers").getAttribute("aria-expanded"), "true");
		assert.equal(host!.querySelector<HTMLElement>('[role="radiogroup"]')!.hidden, false);
		assert.equal(conformerRow("sample-high").getAttribute("aria-checked"), "true");
		assert.equal(host!.querySelector("iframe"), iframe);
		assert.equal(button("Rotate left").disabled, false);
		assert.equal(latestModel(frame), model);
		assert.equal(frame.messages.length, count, "collapse never clears, reloads, or rotates the model");
		assert.equal(requests.length, 1);
		await selectConformer("sample-high");
		assert.equal(frame.messages.length, count, "selecting the current conformer preserves the rendered model");
	} finally {
		if (activeElementDescriptor) Object.defineProperty(document, "activeElement", activeElementDescriptor);
		else Reflect.deleteProperty(document, "activeElement");
	}
});

test("chair summaries show compact orientations and switch with the selected geometry", async () => {
	const result = ensemble();
	const low = result.conformers![1]!;
	low.rings[0]!.substituents = [
		{ atomIndex: 0, substituentAtomIndex: 6, label: "Br", orientation: "equatorial" },
		{ atomIndex: 1, substituentAtomIndex: 7, label: "Me", orientation: "equatorial" },
	];
	result.conformers!.push({
		...low, id: "flipped-chair", sdf: "flipped-chair-geometry", energy: -0.94, relativeEnergy: 0.46,
		rings: [{ ...low.rings[0]!, chairBasin: "negative", substituents: low.rings[0]!.substituents.map(group => ({ ...group, orientation: "axial" })) }],
	});
	mockFetch(() => Response.json(result));
	await mount({ smiles: "Br[C@H]1[C@H](C)CCCC1" });
	const frame = await connectFrame();
	assert.deepEqual([...host!.querySelectorAll('[role="radio"]')].map(row => row.textContent), [
		"ΔE 0.00Br eq., Me eq.", "ΔE 0.46Br ax., Me ax.", "ΔE 5.20non-chair",
	]);
	assert.equal(conformerRow("sample-low").getAttribute("aria-label"), "ΔE 0.00 kcal/mol, Br equatorial, Me equatorial");
	assert.equal(conformerRow("sample-low").querySelector("[title]")!.getAttribute("title"), "Br equatorial, Me equatorial");
	assert.match(host!.querySelector('[data-testid="conformer-details"]')!.textContent!, /ΔE 0.00 kcal\/mol · chair/);
	await pressConformerKey("sample-low", "ArrowDown");
	assert.equal(conformerRow("flipped-chair").getAttribute("aria-checked"), "true");
	assert.equal(conformerRow("flipped-chair").getAttribute("aria-label"), "ΔE 0.46 kcal/mol, Br axial, Me axial");
	assert.equal(latestModel(frame).sdf, "flipped-chair-geometry");
	assert.match(host!.querySelector('[data-testid="conformer-details"]')!.textContent!, /ΔE 0.46 kcal\/mol · chair/);
	assert.equal(requests.length, 1);
});

test("empty summaries, non-chairs, and multiple rings retain their shape labels", async () => {
	const result = ensemble();
	const groups = [{ atomIndex: 0, substituentAtomIndex: 6, label: "Me", orientation: "axial" as const }];
	const high = result.conformers![0]!;
	const low = result.conformers![1]!;
	low.rings[0]!.substituents = [];
	high.rings[0]!.substituents = groups;
	result.conformers!.push({
		...low, id: "multiple-rings", relativeEnergy: 6.2,
		rings: [{ ...low.rings[0]!, substituents: groups }, { ...low.rings[0]!, atomIndices: [7, 8, 9, 10, 11, 12], substituents: groups }],
	});
	mockFetch(() => Response.json(result));
	await mount({ smiles: "C1CCCCC1" });
	assert.deepEqual([...host!.querySelectorAll('[role="radio"]')].map(row => row.textContent), [
		"ΔE 0.00chair", "ΔE 5.20non-chair", "ΔE 6.202 chair rings",
	]);
	assert.doesNotMatch(host!.textContent!, /Me ax\./);
});

test("conformer radio navigation moves focus and selection with arrows, Home, and End", async () => {
	mockFetch(() => Response.json(ensemble()));
	await mount({ smiles: "C1CCCCC1" });
	const frame = await connectFrame();
	let focused: string | undefined;
	for (const row of host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
		row.focus = () => { focused = row.dataset.conformerId; };
	}
	let escapedKeys = 0;
	const listener = () => escapedKeys++;
	window.addEventListener("keydown", listener);
	try {
		const down = await pressConformerKey("sample-low", "ArrowDown");
		assert.equal(down.defaultPrevented, true);
		assert.equal(focused, "sample-high");
		assert.equal(conformerRow("sample-high").getAttribute("tabindex"), "0");
		assert.equal(conformerRow("sample-low").getAttribute("tabindex"), "-1");
		assert.equal(latestModel(frame).sdf, "sample-high-geometry");
		await pressConformerKey("sample-high", "ArrowRight");
		assert.equal(focused, "sample-low", "arrow navigation wraps at the end");
		await pressConformerKey("sample-low", "ArrowUp");
		assert.equal(focused, "sample-high", "arrow navigation wraps at the start");
		await pressConformerKey("sample-high", "Home");
		assert.equal(focused, "sample-low");
		await pressConformerKey("sample-low", "End");
		assert.equal(focused, "sample-high");
		assert.equal(conformerRow("sample-high").getAttribute("aria-checked"), "true");
		assert.equal(escapedKeys, 0, "viewer keys cannot trigger question shortcuts");
	} finally { window.removeEventListener("keydown", listener); }
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
	assert.equal(host!.querySelector('[data-testid="conformer-sidebar"]'), null);
	assert.doesNotMatch(host!.textContent!, /ΔE|kcal\/mol|lowest found/);
	assert.match(host!.textContent!, /energy not evaluated/);
	assert.equal(requests[0]!.search, undefined);
	await act(async () => button("Search conformers").click());
	assert.deepEqual(requests[1], { sdf: "source-sdf", label: "Imported ring", search: true });
	assert.equal(latestModel(frame).sdf, "searched-lowest");
	assert.ok(host!.querySelector('[data-testid="conformer-sidebar"]'));
	await act(async () => button("Show imported coordinates").click());
	assert.equal(requests[2]!.search, undefined);
	assert.equal(latestModel(frame).sdf, "imported-coordinates");
	assert.doesNotMatch(host!.textContent!, /ΔE|kcal\/mol/);
});

test("empty ring validation never invents a chair label", async () => {
	const result = ensemble();
	result.conformers!.forEach(candidate => { candidate.rings = []; });
	mockFetch(() => Response.json(result));
	await mount({ smiles: "CCCC" });
	assert.doesNotMatch(host!.querySelector('[role="radiogroup"]')!.textContent!, /chair|near-planar/);
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
	assert.doesNotMatch(host!.querySelector('[role="radiogroup"]')!.innerHTML, /old-/);
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
