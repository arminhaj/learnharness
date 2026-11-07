import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fast-mode-"));
process.env.LH_DATA_DIR = data;
const { supportsFastMode } = await import("../src/core/model-speed.ts");
const { parseSettingsBody, parseModelsSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { resolveConversationSpec, resolveSettings } = await import("../src/core/settings-resolution.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { refreshChatGPTModels } = await import("../src/agent/chatgpt-bridge.ts");
const { chatGPTPayload } = await import("../src/agent/chatgpt-stream.ts");
const { validateChatSettings, validateModelsSettings, clampModelsLevels } = await import("../src/server/model-catalog.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { POST } = await import("../app/api/chats/route.ts");
const { PUT } = await import("../app/api/chats/[id]/settings/route.ts");
const model = { provider: "openai", id: "gpt-5.4" };
after(() => fs.rmSync(data, { recursive: true, force: true }));

test("Fast accepts documented models and snapshots, without promoting other providers or model variants", () => {
	for (const provider of ["chatgpt", "openai"]) {
		for (const id of ["gpt-5.4", "gpt-5.5", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.4-2026-03-05"]) assert.equal(supportsFastMode(provider, id), true);
		for (const id of ["gpt-5.4-pro", "gpt-5.4-nano", "gpt-99", "ft:gpt-5.4:custom"]) assert.equal(supportsFastMode(provider, id), false);
	}
	for (const provider of ["custom", "openrouter", "claude-code", "github-copilot", undefined]) assert.equal(supportsFastMode(provider, model.id), false);
});

test("settings parsing and disk sanitization retain explicit on/off and reject malformed writes", () => {
	for (const fastMode of [true, false]) {
		assert.deepEqual(parseSettingsBody({ model, thinkingLevel: "high", fastMode }), { ok: true, settings: { model, thinkingLevel: "high", fastMode } });
		const models = { strong: { model, thinkingLevel: "high", fastMode } };
		assert.deepEqual(parseModelsSettingsBody(models), { ok: true, settings: models });
		assert.deepEqual(sanitizeUserSettings({ version: 1, models })?.models, models);
	}
	for (const fastMode of ["true", 1, null, {}]) {
		assert.equal(parseSettingsBody({ fastMode }).ok, false);
		assert.equal(parseModelsSettingsBody({ strong: { model, fastMode } }).ok, false);
	}
	assert.equal(validateChatSettings({ model, fastMode: true }).ok, true);
	assert.equal(validateChatSettings({ model: { provider: "openai", id: "gpt-5.4-pro" }, fastMode: true }).ok, false);
	const unsupported = { strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, fastMode: true } };
	assert.equal(validateModelsSettings(unsupported, unsupported).ok, false, "unchanged model selections cannot bypass the speed gate");
	assert.equal(clampModelsLevels({ strong: { model, thinkingLevel: "high", fastMode: true } }).strong?.fastMode, true);
});

test("new sessions snapshot speed; global changes never enable an existing or legacy session", async () => {
	const create = async () => {
		const response = await POST(new Request("http://test/api/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Fast fixture" }) }));
		assert.equal(response.status, 200);
		return (await response.json()) as { id: string };
	};
	writeSettings({ version: 1, models: { strong: { model, thinkingLevel: "high", fastMode: true } } });
	const first = await create();
	assert.deepEqual(chatStore.getChat(first.id)?.settings, { model, thinkingLevel: "high", fastMode: true });
	writeSettings({ version: 1, models: { strong: { model, thinkingLevel: "high", fastMode: false } } });
	const second = await create();
	assert.equal(chatStore.getChat(first.id)?.settings?.fastMode, true);
	assert.equal(chatStore.getChat(second.id)?.settings?.fastMode, false);
	const response = await PUT(new Request(`http://test/api/chats/${first.id}/settings`, { method: "PUT", body: JSON.stringify({ model, thinkingLevel: "high", fastMode: false }) }), { params: Promise.resolve({ id: first.id }) });
	assert.equal(response.status, 200);
	assert.equal(chatStore.getChat(first.id)?.settings?.fastMode, false);
	const strong = { ...model, fastMode: true };
	assert.equal(resolveConversationSpec({ model }, strong)?.fastMode ?? false, false);
	assert.equal(resolveConversationSpec(undefined, strong)?.fastMode ?? false, false);
	assert.equal(resolveConversationSpec({ model, fastMode: false }, strong)?.fastMode, false);
	const resolved = resolveSettings({ version: 1, models: { strong: { model, fastMode: true }, cheap: { model } } });
	assert.equal(resolved.models.strong?.fastMode, true);
	assert.equal(resolved.agent.models.researcher?.fastMode, undefined, "conversation speed does not opt background assistants into Fast");
});

test("real OpenAI request bodies carry the saved tier and unchanged reasoning, after caller payload observers", async () => {
	const context = normalizeContext({ messages: [{ role: "user", content: "Fixture", timestamp: 1 }] });
	for (const fastMode of [true, false, undefined]) {
		let payload: Record<string, any> | undefined;
		let observed = 0;
		const engine = piEngineForSpec({ ...model, thinkingLevel: "high", fastMode }, false);
		const result = await engine.streamFn(engine.model, context, {
			apiKey: "sk-test-no-network",
			onPayload: async (raw) => { observed++; return { ...raw as object, service_tier: "flex", metadata: { fixture: true } }; },
			fetch: async (input, init) => {
				const request = new Request(input, init);
				payload = JSON.parse(await request.text());
				return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
			},
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(observed, 1);
		assert.equal(payload?.model, model.id);
		assert.equal(payload?.reasoning.effort, "high");
		assert.equal(payload?.service_tier, fastMode ? "priority" : "default");
		assert.deepEqual(payload?.metadata, { fixture: true });
	}
});

test("ChatGPT preserves model and effort on the wire and reports only the final served tier, without retrying fallbacks", async () => {
	const previous = { send: Object.getOwnPropertyDescriptor(process, "send"), connected: Object.getOwnPropertyDescriptor(process, "connected"), marker: process.env.LH_DESKTOP_SERVER, secret: process.env.LH_DESKTOP_API_SECRET };
	const cases = [{ id: model.id, thinkingLevel: "high" }, { id: "gpt-6-astra", thinkingLevel: "max" }] as const;
	const builtins = cases.map(({ id }) => piModels().getModel(model.provider, id) as Model<"openai-responses">);
	const stamp = { epoch: 9, authorityRevision: 1, revision: 1 };
	const status = { available: true, pending: false, allowBackgroundUse: true, activeId: "fast-fixture", accounts: [{ id: "fast-fixture", connected: true, planEnabled: true }], error: null };
	try {
		process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "f".repeat(64);
		Object.defineProperty(process, "connected", { configurable: true, value: true });
		Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
			queueMicrotask(() => (process.emit as (name: string, value: unknown) => boolean)("message", { channel: "lh:chatgpt", id: message.id, op: message.op, ok: true, value: { ...stamp, status, accountId: "fast-fixture", models: cases.map(({ id }) => ({ id, name: "Fixture" })), ...(message.op === "lease" ? { accessToken: "test-oauth-only" } : {}) } }));
			callback?.(); return true;
		} });
		await refreshChatGPTModels(builtins);
		for (const selected of cases) for (const fastMode of [true, false]) for (const served of ["default", "priority", "fast", "auto", undefined]) {
			let body: Record<string, any> | undefined;
			let dispatches = 0;
			const observed: string[] = [];
			const engine = piEngineForSpec({ provider: "chatgpt", ...selected, fastMode }, false);
			const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "Fixture", timestamp: 1 }] }), {
				fetch: async (input, init) => {
					dispatches++;
					const request = new Request(input, init);
					assert.equal(request.url, "https://api.openai.com/v1/responses");
					assert.equal(request.headers.get("authorization"), "Bearer test-oauth-only");
					body = JSON.parse(await request.text());
					const events = [
						{ type: "response.created", response: { service_tier: "auto" } },
						{ type: "response.in_progress", response: { service_tier: "default" } },
						{ type: "response.completed", response: { id: "fixture", status: "completed", service_tier: served, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } },
					];
					return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
				},
				onProviderStreamEvent: raw => { observed.push((raw as { type: string }).type); },
			}).result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(dispatches, 1, "a completed downgrade must never trigger another model request");
			assert.deepEqual(observed, ["response.created", "response.in_progress", "response.completed"]);
			assert.equal(body?.model, selected.id);
			assert.equal(body?.service_tier, fastMode ? "priority" : "default");
			assert.equal(body?.reasoning.effort, selected.thinkingLevel);
			assert.equal(body?.store, false);
			assert.equal(body?.stream, true);
			assert.deepEqual((result as AssistantMessage & { processingTier?: unknown }).processingTier,
				fastMode && ["default", "priority", "fast"].includes(served ?? "") ? { requested: "priority", served } : undefined);
		}
		for (const terminal of ["failed", "incomplete"]) {
			let dispatches = 0;
			const engine = piEngineForSpec({ provider: "chatgpt", id: "gpt-6-astra", thinkingLevel: "max", fastMode: true }, false);
			const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "Fixture", timestamp: 1 }] }), {
				fetch: async () => {
					dispatches++;
					return new Response(`data: ${JSON.stringify({ type: `response.${terminal}`, response: { status: terminal, service_tier: "default", output: [], error: { code: "fixture_failed" } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
				},
			}).result();
			assert.equal(result.stopReason, "error");
			assert.equal(dispatches, 1);
			assert.equal((result as AssistantMessage & { processingTier?: unknown }).processingTier, undefined, "a failed response cannot report successful Standard processing");
		}
		assert.equal(chatGPTPayload({ input: [], service_tier: "ultrafast" }, model.id).service_tier, undefined);
	} finally {
		for (const key of ["send", "connected"] as const) {
			if (previous[key]) Object.defineProperty(process, key, previous[key]!);
			else delete (process as unknown as Record<string, unknown>)[key];
		}
		if (previous.marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = previous.marker;
		if (previous.secret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = previous.secret;
	}
});
