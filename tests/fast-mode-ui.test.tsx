import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ModelControl } from "../components/model-picker.tsx";
import { composeSlotModel } from "../components/settings/agent-section.tsx";
import type { ChatSettings, ModelCatalogEntry, ModelsSettings } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(globalThis, {
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const realFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const model = { provider: "openai", id: "gpt-5.4" };
const entry: ModelCatalogEntry = { ...model, name: "GPT-5.4", reasoning: true, input: ["text"], supportedLevels: ["low", "high"], contextWindow: 100000, maxTokens: 1000, cost: null };
let models: ModelsSettings;
let session: ChatSettings;
let writes: { url: string; body: any }[];
let failSave: boolean;
function fixture(settings: ChatSettings = { model, thinkingLevel: "high" }, entries = [entry]) {
	models = { strong: { model, thinkingLevel: "high" }, cheap: { model: { provider: "fixture", id: "assistant" } } };
	session = settings; writes = []; failSave = false;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body)); writes.push({ url, body });
			if (failSave) return Response.json({ error: "Fixture save rejected" }, { status: 400 });
			if (url === "/api/settings/models") { models = body; return Response.json({ settings: { models } }); }
			session = body; return Response.json({ settings: session });
		}
		if (url === "/api/models") return Response.json({ models: entries, providers: [{ id: "openai", envVar: "", keyPresent: true }], defaults: null, slots: { strong: null, cheap: null, vision: null }, rolePins: {} });
		if (url === "/api/settings") return Response.json({ settings: { models } });
		if (url === "/api/chats/fixture") return Response.json({ settings: session });
		throw new Error(`Unexpected fixture request: ${url}`);
	};
}
async function mount(chatId?: string) {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ModelControl chatId={chatId} />));
}
function element(id: string) { const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`); assert.ok(node, id); return node; }
async function click(id: string) { await act(async () => element(id).click()); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; globalThis.fetch = realFetch; });

test("draft Fast toggles the new-session default, preserving thinking and sibling slots", async () => {
	fixture(); await mount();
	assert.equal(element("stats-fast").getAttribute("aria-pressed"), "false");
	assert.match(element("stats-fast").getAttribute("title")!, /more credits/);
	await click("stats-fast");
	assert.equal(writes[0]?.url, "/api/settings/models");
	assert.deepEqual(writes[0]?.body, { strong: { model, thinkingLevel: "high", fastMode: true }, cheap: { model: { provider: "fixture", id: "assistant" } } });
	assert.equal(element("stats-fast").getAttribute("aria-pressed"), "true");
	await click("stats-fast");
	assert.equal(models.strong?.fastMode, false);
	assert.equal(element("stats-thinking").textContent, "high▾");
});

test("session Fast writes only that session; thinking changes and remounts retain it", async () => {
	fixture(); await mount("fixture"); await click("stats-fast");
	assert.equal(writes[0]?.url, "/api/chats/fixture/settings");
	assert.deepEqual(session, { model, thinkingLevel: "high", fastMode: true });
	assert.equal(models.strong?.fastMode, undefined);
	await click("stats-thinking"); await click("thinking-option-low");
	assert.equal(session.fastMode, true); assert.equal(session.thinkingLevel, "low");
	await act(async () => root?.unmount()); host?.remove(); await mount("fixture");
	assert.equal(element("stats-fast").getAttribute("aria-pressed"), "true");
	await click("stats-fast"); assert.equal(session.fastMode, false);
});

test("unsupported models disable Fast and a failed save keeps the stored value visible", async () => {
	fixture({ model: { provider: "fixture", id: "other" } }, [{ ...entry, provider: "fixture", id: "other" }]);
	await mount("fixture");
	assert.equal(element("stats-fast").hasAttribute("disabled"), true);
	assert.equal(writes.length, 0);
	await act(async () => root?.unmount()); host?.remove();
	fixture(); failSave = true; await mount("fixture"); await click("stats-fast");
	assert.equal(element("stats-fast").getAttribute("aria-pressed"), "false");
	assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /save rejected/);
});

test("other model settings writers preserve Fast for supported selections and clear it on provider changes", () => {
	const original = { strong: { model, thinkingLevel: "high" as const, fastMode: true } };
	assert.equal(composeSlotModel(original, "strong", model.provider, model.id, "low").strong?.fastMode, true);
	assert.equal(composeSlotModel(original, "strong", "claude-code", "sonnet", "high").strong?.fastMode, false);
});
