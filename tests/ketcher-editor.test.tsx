import React, { act } from "react";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { Ketcher } from "ketcher-core";
import type { MoleculeDocument } from "../src/core/chemistry.ts";
import { curvedArrowsDocument } from "./fixtures/curved-arrows.ts";

test("a pending editor change cannot replace the latest arrows with an older save response", async () => {
	const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.assign(globalThis, {
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const captureKey = Symbol.for("learnharness.test.ketcher-editor");
	type EditorProps = { onInit: (editor: Ketcher) => void; errorHandler: (reason: unknown) => void };
	const globals = globalThis as typeof globalThis & { [captureKey]?: (props: EditorProps) => void };
	let editorProps: EditorProps | undefined;
	globals[captureKey] = props => { editorProps = props; };
	const moduleUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`;
	const vendorEditor = moduleUrl('export function Editor(props) { globalThis[Symbol.for("learnharness.test.ketcher-editor")](props); return globalThis.React.createElement("div", { "data-testid": "vendor-canvas" }); }');
	const standalone = moduleUrl("export class StandaloneStructServiceProvider {}");
	const empty = moduleUrl("export {};");
	// Replace vendor UI and CSS only. The component, drawing snapshots, and
	// asynchronous save response handling are the production implementations.
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (context.parentURL?.includes("/components/chemistry/ketcher-editor")) {
				const url = specifier === "ketcher-react" ? vendorEditor
					: specifier === "ketcher-standalone" ? standalone
						: specifier.endsWith(".css") ? empty : undefined;
				if (url) return { url, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	const originalFetch = globalThis.fetch;
	const requests: { document: MoleculeDocument; complete: (response: Response) => void }[] = [];
	let requestStarted!: () => void;
	const nextRequest = () => new Promise<void>(resolve => { requestStarted = resolve; });
	globalThis.fetch = ((input, init) => {
		assert.equal(input, "/api/chemistry/normalize");
		return new Promise<Response>(complete => {
			requests.push({ document: JSON.parse(String(init?.body)), complete });
			requestStarted();
		});
	}) as typeof fetch;
	const listeners = new Set<() => void>();
	let drawing = curvedArrowsDocument;
	const editor = {
		getKet: async () => drawing.ket!,
		editor: { struct: () => ({ atoms: new Map([[0, {}]]) }) },
		changeEvent: {
			add: (listener: () => void) => { listeners.add(listener); },
			remove: (listener: () => void) => { listeners.delete(listener); },
		},
	} as unknown as Ketcher;
	const saved: MoleculeDocument[] = [];
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try {
		const { default: KetcherEditor } = await import("../components/chemistry/ketcher-editor.tsx");
		await act(async () => { root.render(<KetcherEditor onSave={value => saved.push(value)} onCancel={() => {}} />); });
		assert.ok(editorProps);
		await act(async () => editorProps!.onInit(editor));
		assert.equal((window as Window & { ketcher?: Ketcher }).ketcher, editor, "native S-group tools can resolve the live editor");
		await act(async () => editorProps!.errorHandler(new Error("core: <reaction> is not a base molecule")));
		assert.equal(host.querySelector('[role="alert"]')!.textContent, "core: <reaction> is not a base molecule");
		assert.ok(host.querySelector('[data-testid="vendor-canvas"]'), "a rejected chemistry operation leaves the editor mounted");
		await act(async () => editorProps!.errorHandler({ unexpected: true }));
		assert.equal(host.querySelector('[role="alert"]')!.textContent, "Could not complete this drawing operation.");
		const saveButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => /Use structure|Checking structure/.test(button.textContent!))!;
		const canvas = host.querySelector('[aria-label="Molecule drawing canvas"]')!;
		let started = nextRequest();
		await act(async () => { saveButton().click(); await started; });
		assert.equal(canvas.hasAttribute("inert"), true, "the canvas cannot accept input during validation");
		assert.equal(saveButton().disabled, true);
		const updatedKet = JSON.parse(curvedArrowsDocument.ket!);
		updatedKet.root.nodes[1].data.height = 1.4;
		drawing = { ...curvedArrowsDocument, ket: JSON.stringify(updatedKet) };
		// An operation already in flight may finish after input becomes inert.
		await act(async () => { listeners.forEach(changed => changed()); });
		await act(async () => { requests[0]!.complete(Response.json(requests[0]!.document)); });
		assert.equal(saved.length, 0, "an older validated snapshot must never replace a newer arrow edit");
		assert.match(host.querySelector('[role="alert"]')!.textContent!, /drawing changed while saving/i);
		assert.ok(host.querySelector('[data-testid="vendor-canvas"]'), "the editor stays mounted with the newer drawing");
		assert.equal(canvas.hasAttribute("inert"), false);
		started = nextRequest();
		await act(async () => { saveButton().click(); await started; });
		assert.equal(requests[1]!.document.ket, drawing.ket, "retry snapshots the newer arrow geometry");
		await act(async () => { requests[1]!.complete(Response.json(requests[1]!.document)); });
		assert.equal(saved.length, 1);
		assert.equal(saved[0]!.ket, drawing.ket);
	} finally {
		await act(async () => root.unmount());
		assert.notEqual((window as Window & { ketcher?: Ketcher }).ketcher, editor, "closing the editor releases the native reference");
		editorProps?.onInit(editor);
		assert.notEqual((window as Window & { ketcher?: Ketcher }).ketcher, editor, "late vendor initialization cannot restore a closed editor");
		host.remove();
		globalThis.fetch = originalFetch;
		hook.deregister();
		delete globals[captureKey];
	}
});
