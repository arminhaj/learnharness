import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionModel } from "../components/session-core.ts";
import { asAgentMessages, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { projectView, type LiveTurnState } from "../src/core/view.ts";
import type { ProcessingTier } from "../src/core/model-speed.ts";

function response(id: string, processingTier?: ProcessingTier): LhMessage & { role: "assistant" } {
	return {
		...fauxAssistantMessage([fauxThinking("Available summary"), fauxText("Feedback remains complete."), fauxToolCall("explain", { question: "A pending question.", correctAnswer: "A commitment." }, { id: `call_${id}` })], { stopReason: "toolUse" }),
		id, provider: "chatgpt", model: "gpt-6-astra", ...(processingTier ? { processingTier } : {}),
	};
}

function notices(messages: LhMessage[], live?: LiveTurnState) {
	return projectView(messages, live).flatMap(message => message.parts).filter(part => part.type === "data-processing-tier");
}

test("Standard processing notice belongs only to its recorded response and preserves content and tools", () => {
	const first = response("response_standard", { requested: "priority", served: "default" });
	const next = response("response_fast", { requested: "fast", served: "fast" });
	const unreported = response("response_unreported");
	const record = [first, next, unreported];
	const before = structuredClone(record);
	const view = projectView(record);
	const notice = notices(record);
	assert.equal(view.length, 1, "consecutive responses retain their usual grouped document");
	assert.equal(notice.length, 1);
	assert.equal(notice[0]!.sourceMessageId, first.id);
	assert.equal(notice[0]!.id, `${first.id}-processing-tier`);
	assert.deepEqual(notice[0]!.data, first.processingTier);
	const plain = record.map(message => { const { processingTier: _processingTier, ...rest } = message; return rest as LhMessage; });
	assert.deepEqual(view.map(message => ({ ...message, parts: message.parts.filter(part => part.type !== "data-processing-tier") })), projectView(plain));
	assert.deepEqual(record, before, "projection never mutates the saved native replies");
});

test("settled responses keep their notice during later streaming and after JSON reload", () => {
	const settled = response("reported_standard", { requested: "fast", served: "default" });
	const active = response("new_request_unreported");
	active.stopReason = "pending";
	const record = [settled, active];
	const live: LiveTurnState = { executions: new Map(), inFlight: true, streamingIds: new Set([active.id]), activeMessageId: active.id };
	assert.deepEqual(notices(record, live), notices(record));
	assert.deepEqual(notices(JSON.parse(JSON.stringify(record)) as LhMessage[]), notices(record));
	assert.equal(notices(record, live)[0]!.sourceMessageId, settled.id);
});

test("unreported, confirmed Fast, failed, pending, and unrelated-provider responses do not warn", () => {
	for (const served of ["priority", "fast"] as const) assert.deepEqual(notices([response(`served_${served}`, { requested: "priority", served })]), []);
	assert.deepEqual(notices([response("legacy_unreported")]), []);
	for (const stopReason of ["pending", "error", "aborted"] as const) {
		const message = response(`not_success_${stopReason}`, { requested: "priority", served: "default" });
		message.stopReason = stopReason;
		assert.deepEqual(notices([message]), []);
	}
	const foreign = response("foreign_provider", { requested: "priority", served: "default" });
	foreign.provider = "claude-code";
	assert.deepEqual(notices([foreign]), []);
	for (const malformed of [{ requested: "default", served: "default" }, { requested: "priority", served: "auto" }]) {
		const message = response("unconfirmed_runtime_data");
		message.processingTier = malformed as ProcessingTier;
		assert.deepEqual(notices([message]), []);
	}
});

test("processing metadata never enters subsequent model context or changes successful session state", () => {
	const message = response("context_standard", { requested: "priority", served: "default" });
	const before = structuredClone(message);
	const projected = toLlmMessages(asAgentMessages([message]));
	assert.equal(Object.hasOwn(projected[0]!, "processingTier"), false);
	assert.doesNotMatch(JSON.stringify(projected), /data-processing-tier|Standard processing|processingTier/);
	assert.deepEqual(projected[0]!.content, message.content, "model text, reasoning signatures and tool arguments remain exact");
	assert.deepEqual(message, before);
	const state = new SessionModel({ chatId: "processing_notice_fixture", initialMessages: [message] }).getState();
	assert.equal(state.status, "ready");
	assert.equal(state.error, null, "a downgrade is not a failed model response or retry trigger");
	assert.equal(state.nativeMessages[0]!.role, "assistant");
	assert.equal(state.nativeMessages[0]!.role === "assistant" && state.nativeMessages[0]!.stopReason, "toolUse");
});
