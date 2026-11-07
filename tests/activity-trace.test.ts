import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import {
	activityToolOutcome, activityTraceConfig, activityTraceEnabled, createActivityTrace, currentActivityTrace,
	flushActivityTraces, withActivityTrace,
} from "../src/agent/activity-trace.ts";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-activity-trace-"));
const defaults = { ...activityTraceConfig };
const flags = { main: process.env.LH_ACTIVITY_TRACE, summaries: process.env.LH_ACTIVITY_TRACE_SUMMARIES };
let index = 0;
beforeEach(async () => {
	await flushActivityTraces();
	Object.assign(activityTraceConfig, defaults, { directory: path.join(directory, String(++index)) });
	process.env.LH_ACTIVITY_TRACE = "1";
	delete process.env.LH_ACTIVITY_TRACE_SUMMARIES;
});
after(async () => {
	await flushActivityTraces(); Object.assign(activityTraceConfig, defaults);
	for (const [key, value] of [["LH_ACTIVITY_TRACE", flags.main], ["LH_ACTIVITY_TRACE_SUMMARIES", flags.summaries]]) {
		if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
	}
	await fs.rm(directory, { recursive: true, force: true });
});
async function records() {
	await flushActivityTraces();
	const files = await fs.readdir(activityTraceConfig.directory).catch((): string[] => []);
	const text = (await Promise.all(files.filter(file => file.endsWith(".jsonl")).map(file => fs.readFile(path.join(activityTraceConfig.directory, file), "utf8")))).join("");
	return { files, text, lines: text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

test("tracing is off unless explicitly enabled", async () => {
	for (const value of [undefined, "", "0", "false"]) {
		if (value === undefined) delete process.env.LH_ACTIVITY_TRACE; else process.env.LH_ACTIVITY_TRACE = value;
		assert.equal(activityTraceEnabled(), false);
		assert.equal(createActivityTrace({ chatId: "chat", context: "teacher" }), undefined);
	}
	assert.deepEqual((await records()).lines, []);
});

test("correlates async turns, model calls and jobs with monotonic/wall timestamps", async () => {
	const trace = createActivityTrace({ chatId: "chat-1", context: "turn" })!;
	await withActivityTrace(trace, async () => {
		trace.mark("turn.start");
		await Promise.resolve();
		assert.equal(currentActivityTrace(), trace);
		const model = createActivityTrace({ chatId: "chat-1", context: "model-request" })!;
		assert.equal(model.traceId, trace.traceId); assert.notEqual(model.spanId, trace.spanId);
		model.mark("request.dispatch", { model: "unchanged-model", reasoningEffort: "max", requestedServiceTier: "priority" });
		const job = trace.child("job", { jobId: "job-1" });
		job.mark("tool.start", { toolName: "research", toolCallId: "call-1" });
		const other = createActivityTrace({ chatId: "chat-2", context: "turn" })!;
		assert.notEqual(other.traceId, trace.traceId);
	});
	assert.equal(currentActivityTrace(), undefined);
	const { files, lines } = await records();
	assert.equal(files.length, 1); assert.equal(lines.length, 3);
	assert.ok(lines.every(line => Number.isFinite(line.t) && line.elapsedMs >= 0));
	assert.equal(lines[1].parentSpanId, trace.spanId);
	assert.equal(lines[2].jobId, "job-1");
	assert.ok(lines[2].elapsedMs >= lines[0].elapsedMs);
	assert.equal((await fs.stat(activityTraceConfig.directory)).mode & 0o777, 0o700);
	assert.equal((await fs.stat(path.join(activityTraceConfig.directory, files[0]!))).mode & 0o777, 0o600);
});

test("default logs allowlisted metadata but no prompts, arguments, credentials or summary content", async () => {
	const trace = createActivityTrace({ chatId: "chat-1", context: "request" })!;
	trace.mark("request.payload", { model: "same", reasoningEffort: "max", requestBytes: 123, headers: { authorization: "SECRET" }, apiKey: "SECRET", prompt: "SECRET", arguments: "SECRET", summaryText: "SECRET", errorMessage: "SECRET" });
	trace.providerEvent({ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "ri", summary_index: 0, delta: "SUMMARY_SECRET" });
	trace.providerEvent({ type: "response.reasoning_text.delta", output_index: 0, item_id: "ri", delta: "PRIVATE_SECRET" });
	trace.providerEvent({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "ri", encrypted_content: "ENCRYPTED_SECRET", summary: [{ type: "summary_text", text: "SUMMARY_SECRET" }] } });
	trace.providerEvent({ type: "response.function_call_arguments.done", item_id: "fc", name: "read", arguments: "ARGUMENT_SECRET" });
	trace.providerEvent({ type: "response.completed", response: { id: "resp", status: "completed", service_tier: "priority", usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 15 } } } });
	const { text, lines } = await records();
	assert.doesNotMatch(text, /SECRET|authorization|apiKey|encrypted_content|"arguments"/);
	assert.equal(lines.find(line => line.event === "request.payload").reasoningEffort, "max");
	const completed = lines.find(line => line.event === "provider.response.completed");
	assert.equal(completed.returnedServiceTier, "priority");
	assert.equal(completed.reasoningTokens, 15); assert.equal(completed.cachedInputTokens, 80);
});

test("opt-in summaries provide timestamped chunks and reconcile authoritative completed text", async () => {
	process.env.LH_ACTIVITY_TRACE_SUMMARIES = "1";
	const trace = createActivityTrace({ chatId: "chat-1", context: "request" })!;
	trace.providerEvent({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "ri" } });
	trace.providerEvent({ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "ri", summary_index: 0, delta: "Partial " + "a".repeat(1100) });
	trace.providerEvent({ type: "response.reasoning_summary_text.done", output_index: 0, item_id: "ri", summary_index: 0, text: "Partial complete available summary." });
	const item = { type: "reasoning", id: "ri", encrypted_content: "PRIVATE_SECRET", summary: [{ type: "summary_text", text: "Authoritative corrected summary." }] };
	trace.providerEvent({ type: "response.output_item.done", output_index: 0, item });
	trace.providerEvent({ type: "response.completed", response: { status: "completed", output: [item] } });
	const { text, lines } = await records();
	assert.ok(lines.some(line => line.event === "provider.reasoning_summary.delta" && line.summaryText.startsWith("Partial ")));
	const done = lines.filter(line => /reasoning_summary\.(done|reconciled)$/.test(line.event));
	assert.equal(done.length, 2, "final item can reconcile changed content, final response must not duplicate it");
	assert.equal(done.at(-1).summaryText, "Authoritative corrected summary.");
	assert.equal(done.at(-1).summaryChars, 32);
	assert.ok(done.every(line => Number.isFinite(line.elapsedMs)));
	assert.doesNotMatch(text, /PRIVATE_SECRET|encrypted_content/);
});

test("summary text is recovered from final output without intermediate summary events", async () => {
	process.env.LH_ACTIVITY_TRACE_SUMMARIES = "1";
	const trace = createActivityTrace({ chatId: "chat-1", context: "request" })!;
	trace.providerEvent({ type: "response.completed", response: { status: "completed", output: [{ id: "ri", type: "reasoning", summary: [{ type: "summary_text", text: "Available final summary." }], content: [{ type: "reasoning_text", text: "PRIVATE_SECRET" }] }] } });
	const { text, lines } = await records();
	assert.equal(lines.find(line => line.event === "provider.reasoning_summary.done").summaryText, "Available final summary.");
	assert.doesNotMatch(text, /PRIVATE_SECRET|reasoning_text/);
});

test("tool/text observations record milestone timing and names without bodies", async () => {
	const trace = createActivityTrace({ chatId: "chat-1", context: "request" })!;
	for (const type of ["response.created", "response.queued", "response.in_progress"]) trace.providerEvent({ type, response: { id: "resp", status: type.slice(9) } });
	trace.providerEvent({ type: "response.output_text.delta", delta: "VISIBLE_SECRET" });
	trace.providerEvent({ type: "response.output_text.delta", delta: "VISIBLE_SECRET" });
	trace.providerEvent({ type: "response.output_item.added", output_index: 2, item: { id: "fc", type: "function_call", name: "research", call_id: "call1", arguments: "ARG_SECRET" } });
	trace.providerEvent({ type: "response.function_call_arguments.delta", item_id: "fc", delta: "ARG_SECRET" });
	trace.providerEvent({ type: "response.function_call_arguments.done", item_id: "fc", name: "research", arguments: "ARG_SECRET" });
	trace.providerEvent({ type: "response.completed", response: { status: "completed" } });
	const { text, lines } = await records();
	assert.equal(lines.filter(line => line.event === "provider.text.first").length, 1);
	assert.equal(lines.filter(line => line.event === "provider.tool_arguments.first").length, 1);
	assert.equal(lines.find(line => line.event === "provider.item.added").toolName, "research");
	assert.equal(lines.find(line => line.event === "provider.response.completed").textDeltas, 2);
	assert.doesNotMatch(text, /VISIBLE_SECRET|ARG_SECRET/);
});

test("content logging is bounded and explicitly marks truncation", async () => {
	process.env.LH_ACTIVITY_TRACE_SUMMARIES = "1";
	const trace = createActivityTrace({ chatId: "chat-1", context: "request" })!;
	trace.providerEvent({ type: "response.reasoning_summary_text.done", output_index: 0, summary_index: 0, text: "s".repeat(80_000) });
	const { lines } = await records();
	const summary = lines.find(line => line.event === "provider.reasoning_summary.done");
	assert.equal(summary.summaryChars, 80_000);
	assert.equal(summary.summaryText.length, 64 * 1024);
	assert.equal(summary.summaryTruncated, true);
});

test("file caps stop future batches and buffer overflow produces a diagnostic marker", async () => {
	activityTraceConfig.maxFileBytes = 900;
	const trace = createActivityTrace({ chatId: "chat-1", context: "request" })!;
	for (let i = 0; i < 10; i++) trace.mark("request.phase", { phase: "p".repeat(120) });
	let result = await records();
	const before = result.text;
	trace.mark("request.after_cap");
	result = await records();
	assert.equal(result.text, before);
	assert.ok(Buffer.byteLength(result.text) <= 900);
	assert.equal(result.lines.filter(line => line.event === "trace.file_capped").length, 1);
	activityTraceConfig.maxFileBytes = defaults.maxFileBytes;
	activityTraceConfig.directory = path.join(activityTraceConfig.directory, "overflow");
	activityTraceConfig.maxBufferedBytes = 1;
	createActivityTrace({ chatId: "chat-2", context: "turn" })!.mark("request.start");
	const overflow = await records();
	assert.equal(overflow.lines[0].event, "trace.records_dropped");
	assert.equal(overflow.lines[0].droppedRecords, 1);
});

test("retention limits file count and expires old trace files only", async () => {
	activityTraceConfig.maxFiles = 2;
	activityTraceConfig.maxAgeMs = 10_000;
	await fs.mkdir(activityTraceConfig.directory, { recursive: true });
	const old = path.join(activityTraceConfig.directory, "trace_old.jsonl");
	await fs.writeFile(old, "{}\n"); await fs.utimes(old, new Date(0), new Date(0));
	await fs.writeFile(path.join(activityTraceConfig.directory, "unrelated.txt"), "keep");
	for (let i = 0; i < 4; i++) { createActivityTrace({ chatId: String(i), context: "turn" })!.mark("request.start"); await flushActivityTraces(); }
	const { files } = await records();
	assert.equal(files.filter(file => file.endsWith(".jsonl")).length, 2);
	assert.equal(files.includes("trace_old.jsonl"), false);
	assert.equal(await fs.readFile(path.join(activityTraceConfig.directory, "unrelated.txt"), "utf8"), "keep");
});

test("unwritable destinations and unusual metadata never reject or affect execution", async () => {
	await fs.mkdir(activityTraceConfig.directory, { recursive: true });
	const file = path.join(activityTraceConfig.directory, "not-a-directory"); await fs.writeFile(file, "keep");
	activityTraceConfig.directory = file;
	const trace = createActivityTrace({ chatId: "chat-1", context: "turn" })!;
	assert.doesNotThrow(() => trace.mark("event", { model: 1n, httpStatus: Number.NaN, get status() { throw new Error("metadata getter"); } }));
	assert.doesNotThrow(() => trace.providerEvent({ get type() { throw new Error("provider getter"); } }));
	trace.mark("turn.end", { success: true });
	await assert.doesNotReject(flushActivityTraces());
	assert.equal(await fs.readFile(file, "utf8"), "keep");
});

test("tool outcome recognizes explicit error flags without claiming successful execution", () => {
	const result = { content: [{ type: "text", text: "Error detail must not enter trace metadata." }] };
	const before = structuredClone(result);
	assert.deepEqual(activityToolOutcome("read", result, true), { toolOutcome: "reported-error" });
	assert.deepEqual(activityToolOutcome("read", { ...result, isError: true }), { toolOutcome: "reported-error" });
	assert.deepEqual(activityToolOutcome("read", result, false), {});
	assert.deepEqual(result, before);
});

test("known web failure declarations become bounded outcomes without logging their text", async () => {
	const cases = [
		["web_search", "web_search is not available: no search engine is configured. SECRET", "unavailable", "search_not_configured"],
		["web_search", "web_search failed: SECRET", "reported-error", "web_search_failed"],
		["web_fetch", "web_fetch failed: invalid URL SECRET", "reported-error", "web_fetch_failed"],
		["web_fetch", "web_fetch failed for https://SECRET.invalid: HTTP 403", "reported-error", "web_fetch_failed"],
	];
	const trace = createActivityTrace({ chatId: "chat", context: "tool" })!;
	for (const [toolName, text, toolOutcome, errorCode] of cases) {
		const result = { content: [{ type: "text", text }], isError: false };
		const before = structuredClone(result);
		const outcome = activityToolOutcome(toolName!, result, false);
		assert.deepEqual(outcome, { toolOutcome, errorCode });
		assert.deepEqual(result, before);
		trace.mark("tool.end", { toolName, status: "completed", ...outcome });
	}
	const saved = await records();
	assert.doesNotMatch(saved.text, /SECRET|https:/);
	assert.equal(saved.lines[0].status, "completed", "execution status remains independent of the reported operation outcome");
	assert.equal(saved.lines[0].toolOutcome, "unavailable");
});

test("unrecognized tool bodies remain unknown, including quoted failure examples", () => {
	for (const [toolName, result] of [
		["web_search", { content: [{ type: "text", text: "Search returned no results." }] }],
		["web_fetch", { content: [{ type: "text", text: "Article explains why web_fetch failed: is an error prefix." }] }],
		["read", { content: [{ type: "text", text: "web_search failed: quoted source" }] }],
		["web_search", { content: [{ type: "image", text: "web_search failed: image metadata" }] }],
		["web_search", { content: "web_search failed: foreign result" }],
		["web_search", null],
	] as const) assert.deepEqual(activityToolOutcome(toolName, result), {});
	assert.deepEqual(activityToolOutcome("web_search", { get content() { throw new Error("foreign getter"); } }), {});
});
