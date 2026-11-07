import React, { act } from "react";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { ChemicalSearchResult } from "../components/chemistry/chemical-name-search.tsx";

const acid: ChemicalSearchResult = { cid: 1118, title: "Sulfuric Acid", formula: "H2O4S", smiles: "OS(=O)(=O)O" };

test("chemical-name search previews before insertion, ignores stale results, and explains lookup failures", async () => {
	const dom = parseHTML("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
	Object.assign(dom.document, { oninput: null });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const renderer = `data:text/javascript,${encodeURIComponent('export async function drawMolecule() { return \'<svg xmlns="http://www.w3.org/2000/svg"><text>structure</text></svg>\'; }')}`;
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (context.parentURL?.includes("/components/chemistry/chemical-name-search") && /^\.\/rdkit-client(?:\.tsx?|\.js)?$/.test(specifier)) return { url: renderer, shortCircuit: true };
			return nextResolve(specifier, context);
		},
	});
	const requests: { query: string; signal?: AbortSignal | null; complete: (response: Response) => void; fail: (reason: Error) => void }[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = ((url, init) => {
		assert.equal(url, "/api/chemistry/search");
		assert.equal(init?.method, "POST");
		return new Promise<Response>((complete, fail) => {
			requests.push({ query: JSON.parse(String(init?.body)).query, signal: init?.signal, complete, fail });
		});
	}) as typeof fetch;
	const inserted: ChemicalSearchResult[] = [];
	let finishInsertion: (() => void) | undefined;
	const onInsert = async (result: ChemicalSearchResult) => {
		inserted.push(result);
		await new Promise<void>(resolve => { finishInsertion = resolve; });
	};
	const { createRoot } = await import("react-dom/client");
	const { ChemicalNameSearch } = await import("../components/chemistry/chemical-name-search.tsx");
	const host = dom.document.getElementById("root")!;
	const root = createRoot(host);
	let outerSubmissions = 0;
	const outerSubmit = () => { outerSubmissions++; };
	document.addEventListener("submit", outerSubmit);
	const input = () => host.querySelector<HTMLInputElement>("input")!;
	const submit = async () => { await act(async () => { host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); }); };
	const type = async (value: string) => {
		await act(async () => {
			Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
			input().dispatchEvent(new window.Event("input", { bubbles: true }));
		});
	};
	try {
		await act(async () => { root.render(<ChemicalNameSearch onInsert={onInsert} />); });
		assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
		await type("  sulfuric acid  ");
		assert.equal(requests.length, 0, "typing never sends a name lookup");
		await submit();
		assert.equal(requests[0]!.query, "sulfuric acid");
		assert.equal(outerSubmissions, 0, "search must not submit the surrounding answer form");
		assert.match(host.querySelector('[role="status"]')!.textContent!, /Searching PubChem/);
		await act(async () => { requests[0]!.complete(Response.json({ results: [acid] })); });
		assert.equal(inserted.length, 0, "finding a structure must not insert it automatically");
		const image = host.querySelector<HTMLImageElement>("img")!;
		assert.equal(image.alt, "Sulfuric Acid structure");
		assert.match(image.src, /^data:image\/svg\+xml/);
		assert.match(host.textContent!, /H2O4S/);
		assert.equal(host.querySelector("a")!.href, "https://pubchem.ncbi.nlm.nih.gov/compound/1118");
		const insertButton = host.querySelector<HTMLButtonElement>('[aria-label="Insert Sulfuric Acid"]')!;
		await act(async () => { insertButton.click(); insertButton.click(); });
		assert.deepEqual(inserted, [acid], "one insertion is allowed while a prior insertion is pending");
		assert.equal(input().disabled, true);
		await act(async () => { finishInsertion!(); });
		assert.match(host.querySelector('[role="status"]')!.textContent!, /Inserted Sulfuric Acid/);
		assert.equal(host.querySelector('[aria-label="Chemical search results"]'), null, "successful insertion frees canvas space");
		assert.equal(input().value, "  sulfuric acid  ", "the query is retained for another explicit search");

		let escapedKeyEvents = 0;
		const outerKeys = () => { escapedKeyEvents++; };
		document.addEventListener("keydown", outerKeys);
		input().dispatchEvent(new window.Event("keydown", { bubbles: true }));
		document.removeEventListener("keydown", outerKeys);
		assert.equal(escapedKeyEvents, 0, "name entry cannot trigger drawing keyboard tools");

		await type("old search");
		await submit();
		const stale = requests[1]!;
		await type("new search");
		assert.equal(stale.signal!.aborted, true);
		await submit();
		await act(async () => { requests[2]!.complete(Response.json({ error: "No matching compound" }, { status: 404 })); });
		assert.match(host.querySelector('[role="status"]')!.textContent!, /No matching chemicals/);
		await act(async () => { stale.complete(Response.json({ results: [acid] })); });
		assert.equal(host.querySelector('[aria-label="Chemical search results"]'), null, "an ignored abort still cannot publish a stale result");

		await type("sulfuric acid");
		await submit();
		await act(async () => { requests[3]!.fail(new Error("Connection interrupted")); });
		assert.match(host.querySelector('[role="alert"]')!.textContent!, /Connection interrupted/);
		await submit();
		await act(async () => { requests[4]!.complete(Response.json({ results: [acid] })); });
		assert.ok(host.querySelector('[aria-label="Insert Sulfuric Acid"]'), "a failed search can be retried");

		await act(async () => { root.render(<ChemicalNameSearch onInsert={async () => { throw new Error("Drawing is busy"); }} />); });
		await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Insert Sulfuric Acid"]')!.click(); });
		assert.match(host.querySelector('[role="alert"]')!.textContent!, /Drawing is busy/);
		assert.equal(input().disabled, false, "insertion failures leave search usable");

		await type("malformed response");
		await submit();
		await act(async () => { requests.at(-1)!.complete(Response.json(null)); });
		assert.match(host.querySelector('[role="alert"]')!.textContent!, /unreadable response/);

		await type("last search");
		await submit();
		const pending = requests.at(-1)!;
		await act(async () => { root.unmount(); });
		assert.equal(pending.signal!.aborted, true, "closing the editor cancels the outstanding lookup");
		await act(async () => { pending.complete(Response.json({ results: [acid] })); });
	} finally {
		await act(async () => { root.unmount(); });
		document.removeEventListener("submit", outerSubmit);
		globalThis.fetch = originalFetch;
		hook.deregister();
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	}
});
