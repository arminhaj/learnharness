import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { activityTraceConfig, createActivityTrace, currentActivityTrace, flushActivityTraces, withActivityTrace } from "../src/agent/activity-trace.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { handleChatInput } from "../src/server/chat-handler.ts";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-trace-integration-"));
const originalDirectory = activityTraceConfig.directory;
const originalEnabled = process.env.LH_ACTIVITY_TRACE;
activityTraceConfig.directory = directory;
process.env.LH_ACTIVITY_TRACE = "1";
after(async () => {
	await flushActivityTraces();
	activityTraceConfig.directory = originalDirectory;
	if (originalEnabled === undefined) delete process.env.LH_ACTIVITY_TRACE;
	else process.env.LH_ACTIVITY_TRACE = originalEnabled;
	await fs.rm(directory, { recursive: true, force: true });
});

type Row = Record<string, unknown>;
async function rowsFor(chatId: string): Promise<Row[]> {
	await flushActivityTraces();
	const files = await fs.readdir(directory);
	const rows = (await Promise.all(files.filter(file => file.endsWith(".jsonl")).map(async file => (await fs.readFile(path.join(directory, file), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Row)))).flat();
	return rows.filter(row => row.chatId === chatId);
}

function localTool(secret: string): AgentTool {
	return {
		name: "trace_probe", label: "Trace probe", description: "Offline fixture.", parameters: Type.Object({ secret: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: secret }], details: { secret } }),
	};
}

function scriptedEngine(secret: string) {
	const faux = createFauxCore({});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("trace_probe", { secret })], { stopReason: "toolUse" }),
		fauxAssistantMessage(secret, { stopReason: "stop" }),
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

test("manually constructed teacher traces local tools and context without copying model content", async () => {
	const chatId = "chat_trace_manual_teacher";
	const secret = "PRIVATE_TOOL_ARGUMENT_RESULT_AND_ASSISTANT_TEXT";
	const engine = scriptedEngine(secret);
	const parents: string[] = [];
	const agent = createTeacherAgent(undefined, {
		chatId, tools: { trace_probe: localTool(secret) },
		engine: { ...engine, streamFn: (model, context, options) => {
			assert.equal(currentActivityTrace()?.chatId, chatId);
			parents.push(currentActivityTrace()!.spanId);
			return engine.streamFn(model, context, options);
		} },
	});
	await agent.prompt(secret);
	const rows = await rowsFor(chatId);
	assert.equal(parents.length, 2, "tracing must not add or repeat model requests");
	assert.equal(new Set(parents).size, 1);
	assert.equal(rows.filter(row => row.event === "run.start").length, 1);
	assert.equal(rows.filter(row => row.event === "run.end").length, 1);
	assert.equal(rows.filter(row => row.event === "tool.start").length, 1);
	const end = rows.find(row => row.event === "tool.end");
	assert.equal(end?.toolName, "trace_probe");
	assert.equal(end?.status, "completed");
	assert.equal(typeof end?.durationMs, "number");
	assert.ok(rows.some(row => row.event === "local.stage.end" && row.stage === "context-conversion"));
	assert.doesNotMatch(JSON.stringify(rows), new RegExp(secret));
});

test("subagent runs keep actual parent job identities isolated across concurrent scopes", async () => {
	const roots = ["one", "two"].map(suffix => createActivityTrace({ chatId: `chat_trace_job_${suffix}`, context: "job", jobId: `job_${suffix}` })!);
	await Promise.all(roots.map((trace, index) => withActivityTrace(trace, () => runSubagent([localTool("PRIVATE_SUBAGENT_RESULT")], {
		role: "researcher", chatId: trace.chatId, engine: scriptedEngine(`PRIVATE_JOB_${index}`),
		systemPrompt: "PRIVATE_SYSTEM", prompt: "PRIVATE_PROMPT", maxTurns: 2,
	}))));
	for (const trace of roots) {
		const rows = await rowsFor(trace.chatId);
		assert.ok(rows.length > 0);
		assert.ok(rows.every(row => row.traceId === trace.traceId && row.jobId === trace.jobId));
		assert.ok(rows.every(row => row.parentSpanId === trace.spanId));
		assert.equal(rows.filter(row => row.event === "run.end").length, 1);
		assert.equal(rows.find(row => row.event === "run.end")?.status, "completed");
		assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_/);
	}
});

test("teacher and subagent identities override an unrelated ambient chat trace", async () => {
	const parent = createActivityTrace({ chatId: "chat_trace_ambient_parent", context: "job", jobId: "job_unrelated_parent" })!;
	function engineFor(chatId: string) {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage("Offline response")]);
		return { model: faux.getModel(), streamFn: (model: Parameters<typeof faux.streamSimple>[0], context: Parameters<typeof faux.streamSimple>[1], options: Parameters<typeof faux.streamSimple>[2]) => {
			assert.equal(currentActivityTrace()?.chatId, chatId);
			assert.notEqual(currentActivityTrace()?.traceId, parent.traceId);
			return faux.streamSimple(model, context, options);
		} };
	}
	await withActivityTrace(parent, async () => {
		const teacher = createTeacherAgent(undefined, { chatId: "chat_trace_distinct_teacher", tools: {}, engine: engineFor("chat_trace_distinct_teacher") });
		await teacher.prompt("Offline input");
		await runSubagent([], { role: "researcher", chatId: "chat_trace_distinct_subagent", engine: engineFor("chat_trace_distinct_subagent"), systemPrompt: "Offline", prompt: "Offline", maxTurns: 1 });
		assert.equal(currentActivityTrace(), parent);
	});
	for (const chatId of ["chat_trace_distinct_teacher", "chat_trace_distinct_subagent"]) {
		const rows = await rowsFor(chatId);
		assert.ok(rows.length > 0);
		assert.ok(rows.every(row => row.traceId !== parent.traceId && row.parentSpanId !== parent.spanId && row.jobId === undefined));
		assert.equal(rows.filter(row => row.event === "run.start").length, 1);
		assert.equal(rows.filter(row => row.event === "run.end").length, 1);
	}
});

test("unavailable search results are classified without logging their contents", async () => {
	const secret = "PRIVATE_SEARCH_RESULT_DETAILS";
	const webSearch: AgentTool = {
		name: "web_search", label: "Web search", description: "Offline unavailable search fixture.", parameters: Type.Object({ query: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: `web_search is not available: no search engine is configured. ${secret}` }], details: { secret } }),
	};
	function engine() {
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { query: secret })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Offline completion", { stopReason: "stop" }),
		]);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}
	const teacher = createTeacherAgent(undefined, { chatId: "chat_trace_search_teacher", tools: { web_search: webSearch }, engine: engine() });
	await teacher.prompt("Offline input");
	await runSubagent([webSearch], { role: "researcher", chatId: "chat_trace_search_subagent", engine: engine(), systemPrompt: "Offline", prompt: "Offline", maxTurns: 2 });
	for (const chatId of ["chat_trace_search_teacher", "chat_trace_search_subagent"]) {
		const rows = await rowsFor(chatId);
		const end = rows.find(row => row.event === "tool.end");
		assert.equal(end?.status, "completed", "the execution completed even though search was unavailable");
		assert.equal(end?.toolOutcome, "unavailable");
		assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_SEARCH_RESULT_DETAILS|no search engine is configured/);
	}
});

test("refused chat input finishes one request trace without starting a model call", async () => {
	const chatId = "chat_trace_missing_session_fixture";
	const response = await handleChatInput(chatId, { type: "text", text: "PRIVATE_REJECTED_INPUT" });
	assert.equal(response.status, 404);
	const rows = await rowsFor(chatId);
	assert.equal(rows.filter(row => row.event === "run.start").length, 1);
	assert.equal(rows.filter(row => row.event === "run.end").length, 1);
	assert.equal(rows.find(row => row.event === "run.end")?.status, "refused");
	assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_REJECTED_INPUT|model.request/);
});

test("disabled tracing leaves a local subagent result unchanged and writes no records", async () => {
	delete process.env.LH_ACTIVITY_TRACE;
	try {
		const result = await runSubagent([], {
			role: "researcher", chatId: "chat_trace_disabled_fixture", systemPrompt: "Offline", prompt: "Offline", maxTurns: 1,
			engine: (() => { const faux = createFauxCore({}); faux.setResponses([fauxAssistantMessage("Unchanged result")]); return { model: faux.getModel(), streamFn: faux.streamSimple }; })(),
		});
		assert.equal(result.text, "Unchanged result");
		assert.deepEqual(await rowsFor("chat_trace_disabled_fixture"), []);
	} finally { process.env.LH_ACTIVITY_TRACE = "1"; }
});
