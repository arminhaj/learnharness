import React, { act } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
	formatToolShortcut, parseToolShortcuts, shortcutError, TOOL_SHORTCUT_STORAGE_KEY, toolShortcutBinding,
} from "../components/chemistry/tool-shortcuts.ts";

test("tool shortcuts normalize physical keys, reject conflicts/reserved commands, and ignore corrupt stored bindings", () => {
	assert.equal(toolShortcutBinding({ key: "∆", code: "KeyJ", altKey: true, shiftKey: false, ctrlKey: false, metaKey: false }), "alt+j");
	assert.equal(toolShortcutBinding({ key: "Shift", code: "ShiftLeft", altKey: false, shiftKey: true, ctrlKey: false, metaKey: false }), null);
	assert.match(shortcutError("ctrl+z", "erase", {})!, /reserved/);
	assert.match(shortcutError("meta+shift+s", "erase", {})!, /reserved/);
	assert.match(shortcutError("enter", "erase", {})!, /reserved/);
	assert.match(shortcutError("tab", "erase", {})!, /reserved/);
	assert.match(shortcutError("alt+j", "chain", { erase: "alt+j" })!, /already assigned to Erase/);
	assert.equal(shortcutError("alt+j", "erase", { erase: "alt+j" }), null);
	assert.equal(formatToolShortcut("alt+shift+j"), "Alt/Option+Shift+J");
	assert.deepEqual(parseToolShortcuts(JSON.stringify({ version: 1, bindings: { erase: "alt+j", chain: "alt+j", "bond-single": "meta+s", unknown: "k" } })), { erase: "alt+j" });
	assert.deepEqual(parseToolShortcuts("bad json"), {});
	assert.deepEqual(parseToolShortcuts("null"), {});
});

test("custom tool shortcuts persist and activate exact toolbar variants only while drawing", async () => {
	const dom = parseHTML("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
	const stored = new Map<string, string>();
	const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
		HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
		Event: dom.window.Event, localStorage: storage, IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const { EditorShortcuts } = await import("../components/chemistry/editor-shortcuts.tsx");
	const host = document.getElementById("root")!;
	let root = createRoot(host);
	const rootRef = { current: null as HTMLDivElement | null };
	const render = (disabled = false) => <div ref={rootRef}><EditorShortcuts rootRef={rootRef} disabled={disabled} /><button type="button" id="outside-canvas">Outside</button><div aria-label="Molecule drawing canvas" /></div>;
	const click = async (selector: string) => {
		const button = host.querySelector<HTMLButtonElement>(selector)!;
		assert.ok(button, `missing button ${selector}`);
		await act(async () => { button.click(); });
	};
	const key = async (target: Element, binding: { key: string; code?: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean; repeat?: boolean }) => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...binding });
		await act(async () => { target.dispatchEvent(event); await new Promise(resolve => setTimeout(resolve, 0)); });
		return event;
	};
	let selected: string[] = [];
	let wrongMainClicks = 0;
	const canvas = () => host.querySelector<HTMLElement>('[aria-label="Molecule drawing canvas"]')!;
	const bridge = () => canvas().querySelector("textarea[data-cliparea]")!;
	const configureVendor = () => {
		canvas().innerHTML = '<div data-testid="left-toolbar"><button data-testid="erase">Erase</button><button data-testid="chain">Chain</button><div data-testid="bonds-drop-down-button"><button data-testid="bonds">Current bond tool</button><svg data-testid="dropdown-expand"></svg></div><div data-testid="arrows-drop-down-button"><button data-testid="reaction-arrow-elliptical-arc-arrow-open-angle">Current arrow</button><svg data-testid="dropdown-expand"></svg></div></div><svg data-testid="canvas"><path /></svg><textarea data-cliparea="" contenteditable="true"></textarea><input type="text" /><div contenteditable="true"><span id="editable-child">Text</span></div>';
		for (const id of ["erase", "chain"]) canvas().querySelector(`[data-testid="${id}"]`)!.addEventListener("click", () => { selected.push(id); });
		canvas().querySelector('[data-testid="bonds"]')!.addEventListener("click", () => { wrongMainClicks++; });
		for (const [group, options] of [
			["bonds", ["bond-single", "bond-double"]],
			["arrows", ["reaction-arrow-elliptical-arc-arrow-open-angle", "reaction-arrow-elliptical-arc-arrow-open-half-angle"]],
		] as const) {
			canvas().querySelector(`[data-testid="${group}-drop-down-button"] [data-testid="dropdown-expand"]`)!.addEventListener("click", () => {
				queueMicrotask(() => {
					canvas().querySelector('[data-testid="multi-tool-dropdown"]')?.remove();
					const menu = document.createElement("div"); menu.setAttribute("data-testid", "multi-tool-dropdown");
					for (const id of options) {
						const button = document.createElement("button"); button.setAttribute("data-testid", id); button.textContent = id;
						button.addEventListener("click", () => { selected.push(id); menu.remove(); });
						menu.append(button);
					}
					canvas().append(menu);
				});
			});
		}
	};
	try {
		await act(async () => { root.render(render()); });
		configureVendor();
		await click('button[aria-controls]');
		assert.match(host.textContent!, /Built-in: 1/);
		await click('[aria-label="Assign shortcut for Erase"]');
		await key(host.querySelector('[aria-label="Assign shortcut for Chain"]')!, { key: "∆", code: "KeyJ", altKey: true });
		assert.match(host.querySelector('[data-shortcut-tool="erase"]')!.textContent!, /Alt\/Option\+J/);
		assert.deepEqual(JSON.parse(stored.get(TOOL_SHORTCUT_STORAGE_KEY)!).bindings, { erase: "alt+j" });
		await key(bridge(), { key: "∆", code: "KeyJ", altKey: true });
		assert.deepEqual(selected, ["erase"], "Ketcher's clipboard bridge accepts canvas shortcuts");
		assert.equal((await key(bridge(), { key: "1", code: "Digit1" })).defaultPrevented, false, "unassigned native tool shortcuts remain untouched");

		for (const target of [canvas().querySelector("input")!, canvas().querySelector("#editable-child")!, host.querySelector("#outside-canvas")!]) {
			assert.equal((await key(target, { key: "∆", code: "KeyJ", altKey: true })).defaultPrevented, false);
		}
		await key(bridge(), { key: "∆", code: "KeyJ", altKey: true, isComposing: true });
		await key(bridge(), { key: "∆", code: "KeyJ", altKey: true, repeat: true });
		assert.deepEqual(selected, ["erase"], "typing, composition, repeats, and outside controls never switch tools");
		const modal = document.createElement("dialog"); modal.setAttribute("open", ""); canvas().append(modal);
		await key(bridge(), { key: "∆", code: "KeyJ", altKey: true });
		assert.deepEqual(selected, ["erase"], "vendor modal dialogs suppress custom shortcuts");
		modal.remove();

		await click('[aria-label="Assign shortcut for Chain"]');
		await key(bridge(), { key: "j", code: "KeyJ", altKey: true });
		assert.match(host.querySelector('[role="alert"]')!.textContent!, /already assigned to Erase/);
		await key(bridge(), { key: "s", code: "KeyS", metaKey: true });
		assert.match(host.querySelector('[role="alert"]')!.textContent!, /reserved/);
		await key(bridge(), { key: "Enter", code: "Enter" });
		assert.match(host.querySelector('[role="alert"]')!.textContent!, /reserved/);
		const esc = await key(bridge(), { key: "Escape", code: "Escape" });
		assert.equal(esc.defaultPrevented, true, "Escape cancels recording without closing the chemistry dialog");
		assert.equal(host.querySelector('[role="alert"]'), null);

		await click('[aria-label="Assign shortcut for Double bond"]');
		await key(bridge(), { key: "d", code: "KeyD", altKey: true });
		await key(bridge(), { key: "d", code: "KeyD", altKey: true });
		assert.equal(selected.at(-1), "bond-double", "a hidden bond variant is selected through its exact menu item");
		assert.equal(wrongMainClicks, 0, "opening a group never activates its current tool first");
		await click('[aria-label="Assign shortcut for Curved single-electron arrow"]');
		await key(bridge(), { key: "r", code: "KeyR", altKey: true });
		await key(bridge(), { key: "r", code: "KeyR", altKey: true });
		assert.equal(selected.at(-1), "reaction-arrow-elliptical-arc-arrow-open-half-angle");

		await act(async () => { root.unmount(); });
		root = createRoot(host);
		await act(async () => { root.render(render()); });
		configureVendor();
		selected = [];
		await key(bridge(), { key: "j", code: "KeyJ", altKey: true });
		assert.deepEqual(selected, ["erase"], "saved assignments load on a new editor mount");
		await click('button[aria-controls]');
		await click('[aria-label="Clear shortcut for Erase"]');
		assert.equal((await key(bridge(), { key: "j", code: "KeyJ", altKey: true })).defaultPrevented, false, "clear immediately restores the native key path");
		await click('[data-tool-shortcuts] > div > button');
		assert.equal(stored.has(TOOL_SHORTCUT_STORAGE_KEY), false, "reset removes persisted custom assignments");
		await act(async () => { root.render(render(true)); });
		assert.equal(host.querySelector<HTMLButtonElement>('button[aria-controls]')!.disabled, true);
	} finally {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	}
});
