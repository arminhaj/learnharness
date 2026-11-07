import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PATHS } from "../../config.ts";

/** Request diagnostics, independent of the opt-in raw-wire recorder. Never
 * changes model inputs or makes provider calls. Timestamps describe locally
 * observed events, not the provider's private inference/scheduling timeline.
 */
export const activityTraceConfig = {
	directory: path.join(PATHS.debug, "activity-traces"),
	maxFileBytes: 8 * 1024 * 1024,
	maxFiles: 50,
	maxAgeMs: 7 * 24 * 60 * 60 * 1000,
	maxBufferedBytes: 1024 * 1024,
};

export interface ActivityTraceOptions {
	chatId: string;
	context: string;
	jobId?: string;
}

export interface ActivityTrace {
	readonly traceId: string;
	readonly spanId: string;
	readonly chatId: string;
	readonly context: string;
	readonly jobId?: string;
	mark(event: string, fields?: Record<string, unknown>): void;
	child(context: string, options?: { jobId?: string }): ActivityTrace;
	providerEvent(raw: unknown, model?: { provider?: string; id?: string }): void;
}

const local = new AsyncLocalStorage<ActivityTrace>();
const SUMMARY_LIMIT = 64 * 1024;
const metadata = new Set([
	"provider", "model", "reasoningEffort", "reasoningSummaryMode", "requestedServiceTier", "returnedServiceTier", "servedServiceTier",
	"requestId", "responseId", "toolCallId", "toolName", "toolOutcome", "jobId", "role", "status", "errorCode", "errorType", "errorName", "success", "aborted", "stopReason",
	"durationMs", "stage", "phase", "callIndex", "inputMessages", "inputChars", "contextMessages", "contextChars", "inputItems", "payloadBytes", "requestBytes", "toolCount",
	"inputTokens", "inputTokensTotal", "freshInputTokens", "cachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens",
	"summaryIndex", "summaryChars", "summaryDeltas", "summaryTruncated", "sequenceNumber", "outputIndex", "itemId", "itemType", "processingMs", "openaiProcessingMs",
	"httpStatus", "retryAfterMs", "responseHeadersMs", "resultBytes", "dispatchKind", "parentRunId", "operation", "purpose", "messageId",
	"textChars", "textDeltas", "chemistrySteps", "chemistryAtoms", "chemistryArrows", "capped", "truncated", "droppedRecords",
]);

type Queued = { file: string; line: string };
const queue: Queued[] = [];
const dropped = new Map<string, Record<string, unknown>>();
const cappedFiles = new Set<string>();
let bufferedBytes = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<void> | undefined;

export function activityTraceEnabled(): boolean { return process.env.LH_ACTIVITY_TRACE === "1"; }
export function currentActivityTrace(): ActivityTrace | undefined { return local.getStore(); }
export function withActivityTrace<T>(trace: ActivityTrace | undefined, fn: () => T): T {
	return trace ? local.run(trace, fn) : fn();
}

/** Execution completion is not proof of operation success. These web tools
 * intentionally return their known failure strings as normal text results;
 * classify only those declarations and explicit error flags, never arbitrary
 * page content or successful results. No result body is retained or mutated.
 */
export function activityToolOutcome(toolName: string, result: unknown, isError?: boolean): { toolOutcome?: string; errorCode?: string } {
	try {
		if (isError === true || object(result).isError === true) return { toolOutcome: "reported-error" };
		if (toolName !== "web_search" && toolName !== "web_fetch") return {};
		const content = object(result).content;
		if (!Array.isArray(content)) return {};
		for (const block of content) {
			if (object(block).type !== "text" || typeof object(block).text !== "string") continue;
			const text: string = object(block).text;
			if (toolName === "web_search") {
				if (text.startsWith("web_search is not available: no search engine is configured.")) return { toolOutcome: "unavailable", errorCode: "search_not_configured" };
				if (text.startsWith("web_search failed:")) return { toolOutcome: "reported-error", errorCode: "web_search_failed" };
			} else if (text.startsWith("web_fetch failed:") || text.startsWith("web_fetch failed for ")) return { toolOutcome: "reported-error", errorCode: "web_fetch_failed" };
		}
	} catch { /* Foreign result shapes or getters are not operation evidence. */ }
	return {};
}

function clean(fields: Record<string, unknown>): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	for (const key of metadata) {
		const value = fields[key];
		if (typeof value === "string") out[key] = value.slice(0, 256);
		else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
	}
	return out;
}

function schedule(): void {
	if (timer) return;
	timer = setTimeout(() => { timer = undefined; void flushActivityTraces(); }, 100);
	timer.unref();
}

function enqueue(file: string, record: Record<string, unknown>): void {
	try {
		const line = JSON.stringify(record) + "\n";
		const bytes = Buffer.byteLength(line);
		if (bufferedBytes + bytes > activityTraceConfig.maxBufferedBytes) {
			const previous = dropped.get(file);
			if (previous) previous.droppedRecords = Number(previous.droppedRecords) + 1;
			else if (dropped.size < 100) dropped.set(file, { v: 1, t: Date.now(), traceId: record.traceId, spanId: record.spanId, chatId: record.chatId, context: record.context, elapsedMs: record.elapsedMs, event: "trace.records_dropped", droppedRecords: 1 });
			schedule(); return;
		}
		queue.push({ file, line }); bufferedBytes += bytes; schedule();
	} catch { /* Diagnostics cannot break a model operation. */ }
}

async function retain(directory: string): Promise<void> {
	try {
		const names = (await fs.readdir(directory)).filter(name => /^trace_[\w-]+\.jsonl$/.test(name));
		const entries = await Promise.all(names.map(async name => {
			const file = path.join(directory, name); const stat = await fs.lstat(file);
			return { file, stat };
		}));
		const files = entries.filter(entry => entry.stat.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
		await Promise.all(files.map(async (entry, index) => {
			if (index >= activityTraceConfig.maxFiles || Date.now() - entry.stat.mtimeMs > activityTraceConfig.maxAgeMs) await fs.unlink(entry.file).catch(() => {});
		}));
	} catch { /* Missing/closed directory or a concurrent cleanup is harmless. */ }
}

async function writeBatch(batch: Queued[]): Promise<void> {
	const grouped = new Map<string, string[]>();
	for (const { file, line } of batch) {
		const lines = grouped.get(file) ?? []; lines.push(line); grouped.set(file, lines);
	}
	const directories = new Set<string>();
	for (const [file, lines] of grouped) {
		if (cappedFiles.has(file)) continue;
		let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
		try {
			const directory = path.dirname(file); directories.add(directory);
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			await fs.chmod(directory, 0o700);
			handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
			await handle.chmod(0o600);
			let bytes = (await handle.stat()).size;
			let text = "";
			for (const line of lines) {
				const size = Buffer.byteLength(line);
				if (bytes + size > activityTraceConfig.maxFileBytes) {
					const marker = JSON.stringify({ v: 1, t: Date.now(), event: "trace.file_capped", capped: true }) + "\n";
					if (bytes + Buffer.byteLength(marker) <= activityTraceConfig.maxFileBytes) text += marker;
					cappedFiles.add(file);
					if (cappedFiles.size > 100) cappedFiles.delete(cappedFiles.values().next().value!);
					break;
				}
				text += line; bytes += size;
			}
			if (text) await handle.writeFile(text, "utf8");
		} catch { /* Read-only/full disks and permission failures are no-ops. */ }
		finally { await handle?.close().catch(() => {}); }
	}
	for (const directory of directories) await retain(directory);
}

/** Drain queued metadata/summaries before a diagnostic run exits. No rejection
 * reaches a caller, even if the destination is unavailable or disk is full.
 */
export async function flushActivityTraces(): Promise<void> {
	try {
		if (timer) { clearTimeout(timer); timer = undefined; }
		while (writing || queue.length || dropped.size) {
			if (writing) { await writing; continue; }
			const batch = queue.splice(0); bufferedBytes = 0;
			for (const [file, record] of dropped) batch.push({ file, line: JSON.stringify(record) + "\n" });
			dropped.clear();
			writing = writeBatch(batch).catch(() => {});
			await writing; writing = undefined;
		}
	} catch { writing = undefined; }
}

type Summary = { chars: number; deltas: number; text: string; pending: string; lastChunkAt: number; first: boolean; done: boolean; truncated: boolean; fields: Record<string, unknown>; finalDigest?: string };
function object(value: unknown): Record<string, any> { return value && typeof value === "object" ? value as Record<string, any> : {}; }

function makeTrace(options: ActivityTraceOptions, parent?: ActivityTrace, start = performance.now()): ActivityTrace {
	const traceId = parent?.traceId ?? `trace_${randomUUID()}`;
	const spanId = randomUUID();
	const file = path.join(activityTraceConfig.directory, traceId + ".jsonl");
	const summaries = new Map<string, Summary>();
	const completedItems = new Set<string>();
	const summaryTextEnabled = process.env.LH_ACTIVITY_TRACE_SUMMARIES === "1";
	let summaryStoredChars = 0, firstEvent = true, firstText = true, firstArguments = true, textChars = 0, textDeltas = 0;
	const emit = (event: string, fields: Record<string, unknown> = {}, summaryText?: string) => {
		try {
			if (!activityTraceEnabled()) return;
			const record = {
				v: 1, t: Date.now(), elapsedMs: Math.round((performance.now() - start) * 1000) / 1000,
				traceId, spanId, ...(parent ? { parentSpanId: parent.spanId } : {}),
				chatId: options.chatId.slice(0, 256), context: options.context.slice(0, 128), ...(options.jobId ? { jobId: options.jobId.slice(0, 256) } : {}),
				event: event.replace(/[^\w.:-]/g, "_").slice(0, 120), ...clean(fields),
				...(summaryTextEnabled && summaryText !== undefined ? { summaryText } : {}),
			};
			enqueue(file, record);
		} catch { /* Observers never affect the run. */ }
	};
	const trace: ActivityTrace = {
		traceId, spanId, chatId: options.chatId, context: options.context, ...(options.jobId ? { jobId: options.jobId } : {}),
		mark: (event, fields) => emit(event, fields),
		child: (context, child = {}) => makeTrace({ chatId: options.chatId, context, jobId: child.jobId ?? options.jobId }, trace, start),
		providerEvent(raw, model) {
			try {
				const event = object(raw); const type = typeof event.type === "string" ? event.type : "unknown";
				const response = object(event.response), item = object(event.item);
				const fields = { provider: model?.provider, model: model?.id, responseId: event.response_id ?? response.id, sequenceNumber: event.sequence_number, outputIndex: event.output_index, itemId: event.item_id ?? item.id };
				if (firstEvent) { firstEvent = false; emit("provider.first_event", { ...fields, status: type }); }
				const keyFor = (index: number | undefined) => `${String(event.output_index ?? event.item_id ?? item.id ?? "unknown").slice(0, 256)}:${index ?? 0}`;
				const summary = (index: number | undefined, delta?: string, completedText?: string, done = false) => {
					const key = keyFor(index);
					if (!summaries.has(key) && summaries.size >= 256) return;
					const state = summaries.get(key) ?? { chars: 0, deltas: 0, text: "", pending: "", lastChunkAt: performance.now(), first: true, done: false, truncated: false, fields: clean({ ...fields, summaryIndex: index }) };
					const wasDone = state.done;
					if (wasDone && completedText === undefined) return;
					const digest = completedText === undefined ? undefined : createHash("sha256").update(completedText).digest("hex");
					if (wasDone && digest === state.finalDigest) return;
					const chunk = () => {
						if (!summaryTextEnabled || !state.pending) return;
						emit("provider.reasoning_summary.delta", { ...state.fields, summaryChars: state.chars, summaryDeltas: state.deltas }, state.pending);
						state.pending = ""; state.lastChunkAt = performance.now();
					};
					if (delta !== undefined) { state.chars += delta.length; state.deltas++;
						if (summaryTextEnabled) { const room = Math.max(0, SUMMARY_LIMIT - summaryStoredChars); const kept = delta.slice(0, room); state.text += kept; state.pending += kept; summaryStoredChars += kept.length; state.truncated ||= kept.length < delta.length; }
					}
					if (completedText !== undefined) {
						chunk();
						state.chars = completedText.length;
						state.finalDigest = digest;
						if (summaryTextEnabled) { const room = Math.max(0, SUMMARY_LIMIT - summaryStoredChars + state.text.length); summaryStoredChars -= state.text.length; state.text = completedText.slice(0, room); summaryStoredChars += state.text.length; state.truncated = state.text.length < completedText.length; }
					}
					if (state.first) { state.first = false; emit("provider.reasoning_summary.first", { ...fields, summaryIndex: index }); }
					if (state.pending.length >= 1024 || performance.now() - state.lastChunkAt >= 250) chunk();
					if (done) { chunk(); state.done = true; emit(wasDone ? "provider.reasoning_summary.reconciled" : "provider.reasoning_summary.done", { ...fields, summaryIndex: index, summaryChars: state.chars, summaryDeltas: state.deltas, summaryTruncated: state.truncated }, summaryTextEnabled ? state.text : undefined); }
					summaries.set(key, state);
				};
				if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") summary(event.summary_index, event.delta);
				else if (type === "response.reasoning_summary_text.done") summary(event.summary_index, undefined, typeof event.text === "string" ? event.text : undefined, true);
				else if (type === "response.reasoning_summary_part.done") summary(event.summary_index, undefined, object(event.part).type === "summary_text" && typeof object(event.part).text === "string" ? object(event.part).text : undefined, true);
				else if (type === "response.output_item.added" || type === "response.output_item.done") {
					const itemKey = String(item.id ?? event.output_index ?? "unknown").slice(0, 256) + ":" + String(item.type).slice(0, 64);
					if (!type.endsWith(".done") || !completedItems.has(itemKey)) emit(type === "response.output_item.added" ? "provider.item.added" : "provider.item.done", { ...fields, itemType: item.type, toolName: item.name, toolCallId: item.call_id });
					if (type.endsWith(".done") && completedItems.size < 4096) completedItems.add(itemKey);
					if (type.endsWith(".done") && item.type === "reasoning" && Array.isArray(item.summary)) item.summary.forEach((part: unknown, index: number) => { const value = object(part); if (value.type === "summary_text" && typeof value.text === "string") summary(index, undefined, value.text, true); });
				} else if (type === "response.output_text.delta") {
					textChars += typeof event.delta === "string" ? event.delta.length : 0; textDeltas++;
					if (firstText) { firstText = false; emit("provider.text.first", fields); }
				} else if (type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") {
					if (firstArguments) { firstArguments = false; emit("provider.tool_arguments.first", fields); }
				} else if (type === "response.function_call_arguments.done" || type === "response.custom_tool_call_input.done") emit("provider.tool_arguments.done", { ...fields, toolName: event.name, toolCallId: event.call_id });
				if (["response.created", "response.queued", "response.in_progress", "response.completed", "response.failed", "response.incomplete", "error"].includes(type)) {
					// Some transports supply available summaries only in the final
					// output. Reconcile those without reading encrypted/private text.
					if (Array.isArray(response.output)) response.output.forEach((value: unknown, index: number) => {
						if (object(value).type === "reasoning") trace.providerEvent({ type: "response.output_item.done", output_index: index, item: value }, model);
					});
					if (["response.completed", "response.failed", "response.incomplete", "error"].includes(type)) for (const state of summaries.values()) {
						if (state.done) continue;
						state.done = true;
						if (summaryTextEnabled && state.pending) emit("provider.reasoning_summary.delta", { ...state.fields, summaryChars: state.chars, summaryDeltas: state.deltas }, state.pending);
						state.pending = "";
						emit("provider.reasoning_summary.observed_end", { ...state.fields, status: type, summaryChars: state.chars, summaryDeltas: state.deltas, summaryTruncated: state.truncated }, summaryTextEnabled ? state.text : undefined);
					}
					const usage = object(response.usage), inputDetails = object(usage.input_tokens_details), outputDetails = object(usage.output_tokens_details);
					emit(`provider.${type}`, { ...fields, status: response.status, returnedServiceTier: response.service_tier, errorCode: event.code ?? object(event.error).code ?? object(response.error).code,
						inputTokensTotal: usage.input_tokens, cachedInputTokens: inputDetails.cached_tokens, outputTokens: usage.output_tokens, reasoningTokens: outputDetails.reasoning_tokens, textChars, textDeltas });
				}
			} catch { /* Unknown provider events are observational only. */ }
		},
	};
	return trace;
}

export function createActivityTrace(options: ActivityTraceOptions): ActivityTrace | undefined {
	if (!activityTraceEnabled()) return undefined;
	try {
		const parent = currentActivityTrace();
		return parent?.chatId === options.chatId ? parent.child(options.context, { jobId: options.jobId }) : makeTrace(options);
	} catch { return undefined; }
}
