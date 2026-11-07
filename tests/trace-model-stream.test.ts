import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Model, StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { activityTraceConfig, createActivityTrace, flushActivityTraces, withActivityTrace } from "../src/agent/activity-trace.ts";
import { traceModelStream } from "../src/agent/trace-model-stream.ts";

const model = { id: "unchanged-model", provider: "chatgpt", api: "openai-responses" } as Model<"openai-responses">;
const context = normalizeContext({ messages: [] });
const savedDirectory = activityTraceConfig.directory;
const savedEnabled = process.env.LH_ACTIVITY_TRACE;
const savedSummaries = process.env.LH_ACTIVITY_TRACE_SUMMARIES;
let directory: string;
before(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-trace-stream-"));
	activityTraceConfig.directory = directory;
});
after(async () => {
	await flushActivityTraces();
	activityTraceConfig.directory = savedDirectory;
	if (savedEnabled === undefined) delete process.env.LH_ACTIVITY_TRACE; else process.env.LH_ACTIVITY_TRACE = savedEnabled;
	if (savedSummaries === undefined) delete process.env.LH_ACTIVITY_TRACE_SUMMARIES; else process.env.LH_ACTIVITY_TRACE_SUMMARIES = savedSummaries;
	await fs.rm(directory, { recursive: true, force: true });
});

function response(): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "chatgpt", model: model.id, content: [], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 17, cacheRead: 100, cacheWrite: 0, output: 9, reasoning: 7, totalTokens: 126, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

async function rows(traceId: string): Promise<Record<string, any>[]> {
	await flushActivityTraces();
	return (await fs.readFile(path.join(directory, traceId + ".jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

test("disabled instrumentation preserves the original options and stream object", () => {
	delete process.env.LH_ACTIVITY_TRACE;
	const original = new AssistantMessageEventStream();
	const options: StreamOptions = { headers: { "x-test": "same" } };
	const fn: StreamFunction<"openai-responses"> = (m, c, o) => { assert.equal(m, model); assert.equal(c, context); assert.equal(o, options); return original; };
	assert.equal(traceModelStream(fn)(model, context, options), original);
});

test("tracing preserves the payload, abort signal, observer, and stream consumption", async () => {
	process.env.LH_ACTIVITY_TRACE = "1";
	process.env.LH_ACTIVITY_TRACE_SUMMARIES = "1";
	const root = createActivityTrace({ chatId: "chat_same", context: "test" })!;
	const original = new AssistantMessageEventStream();
	const controller = new AbortController();
	const body = JSON.stringify({ model: model.id, reasoning: { effort: "max", summary: "auto" }, service_tier: "priority", input: [{ role: "user", content: "PRIVATE_PROMPT" }] });
	const init = { method: "POST", body, headers: { authorization: "Bearer PRIVATE_CREDENTIAL" }, signal: controller.signal };
	let observed = 0;
	let request: Promise<Response> | undefined;
	const result = response();
	const fn: StreamFunction<"openai-responses"> = (_m, _c, opts) => {
		assert.equal(opts!.signal, controller.signal);
		request = opts!.fetch!("https://example.invalid/model", init).then(async value => {
			await opts!.onProviderStreamEvent!({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_test", encrypted_content: "PRIVATE_ENCRYPTED" } }, model);
			await opts!.onProviderStreamEvent!({ type: "response.reasoning_summary_text.done", item_id: "rs_test", summary_index: 0, text: "Checking the supplied structures." }, model);
			original.push({ type: "start", partial: result });
			original.push({ type: "done", reason: "stop", message: result });
			original.end();
			return value;
		});
		return original;
	};
	const returned = withActivityTrace(root, () => traceModelStream(fn)(model, context, {
		signal: controller.signal,
		fetch: async (input, actual) => { assert.equal(input, "https://example.invalid/model"); assert.equal(actual, init); return new Response("", { headers: { "x-request-id": "req_same", "openai-processing-ms": "12", "set-cookie": "PRIVATE_COOKIE" } }); },
		onProviderStreamEvent: () => { observed++; },
	}));
	assert.equal(returned, original);
	await request;
	assert.equal(await returned.result(), result);
	const events = [];
	for await (const event of returned) events.push(event.type);
	assert.deepEqual(events, ["start", "done"], "logging must not consume the caller's events");
	assert.equal(observed, 2);
	assert.equal(init.body, body);
	const log = await rows(root.traceId);
	const dispatch = log.find(row => row.event === "request.dispatch")!;
	assert.equal(dispatch.reasoningEffort, "max");
	assert.equal(dispatch.reasoningSummaryMode, "auto");
	assert.equal(dispatch.requestedServiceTier, "priority");
	assert.equal(dispatch.payloadBytes, Buffer.byteLength(body));
	const end = log.find(row => row.event === "model-request.end")!;
	assert.equal(end.inputTokensTotal, 117);
	assert.equal(end.reasoningTokens, 7);
	assert.equal(end.parentSpanId, root.spanId);
	assert.equal(log.find(row => row.event === "request.headers")!.requestId, "req_same");
	const text = JSON.stringify(log);
	assert.match(text, /Checking the supplied structures/);
	assert.doesNotMatch(text, /PRIVATE_PROMPT|PRIVATE_CREDENTIAL|PRIVATE_ENCRYPTED|PRIVATE_COOKIE/);
});

test("synchronous failures preserve exception identity and exclude error contents", async () => {
	process.env.LH_ACTIVITY_TRACE = "1";
	const root = createActivityTrace({ chatId: "chat_error", context: "test" })!;
	const failure = new Error("PRIVATE_ERROR_CONTENT");
	const fn: StreamFunction<"openai-responses"> = () => { throw failure; };
	assert.throws(() => withActivityTrace(root, () => traceModelStream(fn)(model, context)), error => error === failure);
	const log = await rows(root.traceId);
	assert.equal(log.find(row => row.event === "model-request.end")!.status, "error");
	assert.doesNotMatch(JSON.stringify(log), /PRIVATE_ERROR_CONTENT/);
});

test("overlapping HTTP requests retain their individual dispatch identities", async () => {
	process.env.LH_ACTIVITY_TRACE = "1";
	const root = createActivityTrace({ chatId: "chat_parallel", context: "test" })!;
	const original = new AssistantMessageEventStream();
	let finishFirst: (() => void) | undefined;
	let requests: Promise<unknown> | undefined;
	const fn: StreamFunction<"openai-responses"> = (_m, _c, opts) => {
		requests = Promise.all([opts!.fetch!("https://example.invalid/one"), opts!.fetch!("https://example.invalid/two")]).then(() => {
			original.push({ type: "done", reason: "stop", message: response() }); original.end();
		});
		return original;
	};
	withActivityTrace(root, () => traceModelStream(fn)(model, context, {
		fetch: async input => {
			if (String(input).endsWith("one")) await new Promise<void>(resolve => { finishFirst = resolve; });
			return new Response("", { headers: { "x-request-id": String(input).endsWith("one") ? "req_one" : "req_two" } });
		},
	}));
	await Promise.resolve();
	finishFirst!();
	await requests;
	const log = await rows(root.traceId);
	const headers = log.filter(row => row.event === "request.headers");
	assert.deepEqual(headers.map(row => [row.requestId, row.callIndex]), [["req_two", 2], ["req_one", 1]]);
});
