import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { AppearanceSettings } from "../src/core/settings.ts";

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
const cache = new Map<string, string>();
const storageKey = "learnharness-appearance-mode";
const listeners = new Set<(event: { matches: boolean }) => void>();
let systemDark = false;
const media = {
	get matches() { return systemDark; },
	addListener: (listener: (event: { matches: boolean }) => void) => listeners.add(listener),
	removeListener: (listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
};
Object.assign(globalThis, {
	React,
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: {
		getItem: (key: string) => cache.get(key) ?? null,
		setItem: (key: string, value: string) => cache.set(key, value),
		removeItem: (key: string) => cache.delete(key),
	},
});
Object.assign(dom.window, {
	matchMedia: (query: string) => {
		assert.equal(query, "(prefers-color-scheme: dark)");
		return media;
	},
});

// Import after installing the browser globals: next-themes detects the
// environment once at module evaluation, just as it does in the real app.
const { AppearanceProvider, useAppearance } = await import("../components/settings/appearance.tsx");
let current: ReturnType<typeof useAppearance> | null = null;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let fetchCount = 0;
const originalFetch = globalThis.fetch;

function ObserveAppearance() {
	current = useAppearance();
	return <output>{current.appearance.mode}:{current.resolvedMode}</output>;
}

async function mount(response: () => Promise<Response>) {
	globalThis.fetch = async (input, init) => {
		assert.equal(String(input), "/api/settings");
		assert.equal(init?.method ?? "GET", "GET");
		fetchCount++;
		return response();
	};
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<AppearanceProvider><ObserveAppearance /></AppearanceProvider>);
	});
}

async function unmount() {
	await act(async () => { root?.unmount(); });
	root = null;
	host?.remove();
	host = null;
	current = null;
	assert.equal(listeners.size, 0, "the OS theme listener is removed on unmount");
}

function snapshot() {
	assert.ok(current);
	return current;
}

async function choose(appearance: AppearanceSettings | undefined) {
	await act(async () => { snapshot().onAppearanceChange(appearance); });
}

async function changeSystem(dark: boolean) {
	await act(async () => {
		systemDark = dark;
		for (const listener of [...listeners]) listener({ matches: dark });
	});
}

function assertMode(mode: "light" | "dark") {
	assert.equal(snapshot().resolvedMode, mode);
	assert.ok(document.documentElement.classList.contains(mode));
	assert.ok(!document.documentElement.classList.contains(mode === "dark" ? "light" : "dark"));
	assert.equal(document.documentElement.style.colorScheme, mode);
	assert.ok(document.documentElement.classList.contains("font-fixture"), "unrelated root classes survive");
}

beforeEach(() => {
	cache.clear();
	systemDark = false;
	fetchCount = 0;
	document.documentElement.className = "font-fixture";
	document.documentElement.removeAttribute("style");
});

afterEach(async () => {
	await unmount();
	globalThis.fetch = originalFetch;
});

describe("appearance mode application", () => {
	it("restores System and responds to OS changes without changing the saved choice or refetching", async () => {
		await mount(async () => Response.json({ settings: { appearance: { mode: "system" } } }));
		assertMode("light");
		await changeSystem(true);
		assertMode("dark");
		await changeSystem(false);
		assertMode("light");
		assert.equal(snapshot().appearance.mode, "system");
		assert.equal(cache.get(storageKey), "system");
		assert.equal(fetchCount, 1);
	});

	it("applies explicit modes immediately and ignores OS changes until System is selected", async () => {
		await mount(async () => Response.json({ settings: {} }));
		assertMode("dark");
		await choose({ mode: "light" });
		await changeSystem(true);
		assertMode("light");
		await choose({ mode: "dark" });
		await changeSystem(false);
		assertMode("dark");
		await choose({ mode: "system" });
		assertMode("light");
		assert.equal(fetchCount, 1);
	});

	it("re-derives custom surfaces on a mode change and clears overrides when reset", async () => {
		const appearance: AppearanceSettings = {
			mode: "system", background: "#d0d0d0", fontFamily: "Georgia", sessionNameSerif: false,
			mdRendering: { boldColor: "#112233" },
		};
		await mount(async () => Response.json({ settings: { appearance } }));
		const style = document.documentElement.style;
		assert.equal(style.getPropertyValue("--card"), "#c8c8c8");
		await changeSystem(true);
		assert.equal(style.getPropertyValue("--card"), "#d8d8d8");
		assert.match(style.getPropertyValue("--font-prose"), /Georgia/);
		await choose({ mode: "light", background: null });
		assertMode("light");
		for (const token of ["--background", "--card", "--border", "--font-prose", "--font-title", "--lh-ink-strong"]) {
			assert.ok(!style.getPropertyValue(token), `${token} must return to the stylesheet default`);
		}
		assert.equal(style.getPropertyValue("--lh-prose-size"), "16px");
	});

	it("uses the cached selection after reload even if the settings request fails", async () => {
		await mount(async () => Response.json({ settings: {} }));
		await choose({ mode: "light" });
		assert.equal(cache.get(storageKey), "light");
		await unmount();
		document.documentElement.className = "font-fixture";
		await mount(async () => new Response(null, { status: 503 }));
		assertMode("light");
		assert.equal(cache.get(storageKey), "light");
	});

	it("does not let a delayed initial settings response undo a newer saved selection", async () => {
		let resolveResponse!: (response: Response) => void;
		const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
		await mount(() => response);
		await choose({ mode: "light" });
		await act(async () => {
			resolveResponse(Response.json({ settings: { appearance: { mode: "dark" } } }));
		});
		assertMode("light");
		assert.equal(snapshot().appearance.mode, "light");
		assert.equal(cache.get(storageKey), "light");
	});
});
