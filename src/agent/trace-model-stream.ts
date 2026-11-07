import type { Api, AssistantMessage, StreamFunction } from "@earendil-works/pi-ai";
import { currentActivityTrace, withActivityTrace, type ActivityTrace } from "./activity-trace.ts";

function usageFields(message: AssistantMessage): Record<string, unknown> {
	const usage = message.usage;
	return {
		stopReason: message.stopReason,
		freshInputTokens: usage?.input,
		cacheReadTokens: usage?.cacheRead,
		cacheWriteTokens: usage?.cacheWrite,
		inputTokensTotal: usage ? usage.input + usage.cacheRead + usage.cacheWrite : undefined,
		outputTokens: usage?.output,
		reasoningTokens: usage?.reasoning,
	};
}

/** Read only request controls and sizes, never prompt/tool/credential content. */
function requestFields(init?: RequestInit): Record<string, unknown> {
	if (typeof init?.body !== "string") return {};
	const fields: Record<string, unknown> = { payloadBytes: Buffer.byteLength(init.body) };
	try {
		const body = JSON.parse(init.body) as Record<string, unknown>;
		if (typeof body.service_tier === "string") fields.requestedServiceTier = body.service_tier;
		if (Array.isArray(body.input)) fields.inputItems = body.input.length;
		if (body.reasoning && typeof body.reasoning === "object") {
			const reasoning = body.reasoning as Record<string, unknown>;
			if (typeof reasoning.effort === "string") fields.reasoningEffort = reasoning.effort;
			if (typeof reasoning.summary === "string") fields.reasoningSummaryMode = reasoning.summary;
		}
	} catch { /* Other adapters need not use a JSON request body. */ }
	return fields;
}

function headersFields(response: Response): Record<string, unknown> {
	const fields: Record<string, unknown> = { httpStatus: response.status };
	const id = response.headers.get("x-request-id");
	if (id) fields.requestId = id.slice(0, 200);
	const processing = response.headers.get("openai-processing-ms");
	if (processing !== null && processing.trim() && Number.isFinite(Number(processing))) {
		fields.openaiProcessingMs = Number(processing);
	}
	return fields;
}

/** Observe without consuming, replacing, cloning, or buffering the model
 * stream. result() is Pi's existing completion promise, not another reader.
 * The caller receives the identical stream and request options retain their
 * payload, model, effort, speed, abort signal, and retry behavior.
 */
export function traceModelStream<TApi extends Api>(streamFn: StreamFunction<TApi>): StreamFunction<TApi> {
	return (model, context, options) => {
		const parent = currentActivityTrace();
		if (!parent) return streamFn(model, context, options);
		const trace = parent.child("model-request");
		const started = performance.now();
		let dispatches = 0;
		trace.mark("model-request.start", {
			provider: model.provider, model: model.id,
			reasoningEffort: (options as { reasoning?: string } | undefined)?.reasoning,
			contextMessages: context.messages.length,
		});
		return withActivityTrace(trace, () => {
			const delegate = options?.fetch ?? globalThis.fetch;
			let stream: ReturnType<StreamFunction<TApi>>;
			try {
				stream = streamFn(model, context, {
					...options,
					fetch: async (input, init) => {
						const dispatched = performance.now();
						const callIndex = ++dispatches;
						trace.mark("request.dispatch", { ...requestFields(init), callIndex });
						try {
							const response = await delegate(input, init);
							trace.mark("request.headers", { ...headersFields(response), durationMs: performance.now() - dispatched, callIndex });
							return response;
						} catch (error) {
							trace.mark("request.error", { errorName: safeErrorName(error), durationMs: performance.now() - dispatched, callIndex });
							throw error;
						}
					},
					onProviderStreamEvent: async (raw, eventModel) => {
						trace.providerEvent(raw, eventModel);
						await options?.onProviderStreamEvent?.(raw, eventModel);
					},
				});
			} catch (error) {
				trace.mark("model-request.end", { status: "error", errorName: safeErrorName(error), durationMs: performance.now() - started });
				throw error;
			}
			void stream.result().then(message => {
				trace.mark("model-request.end", {
					...usageFields(message), status: message.stopReason === "error" || message.stopReason === "aborted" ? message.stopReason : "completed",
					durationMs: performance.now() - started,
				});
			}, error => {
				trace.mark("model-request.end", { status: "error", errorName: safeErrorName(error), durationMs: performance.now() - started });
			});
			return stream;
		});
	};
}

function safeErrorName(error: unknown): string {
	return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name) ? error.name : "Error";
}

/** Stage instrumentation for the subscription transport before dispatch. */
export function traceLease(trace: ActivityTrace | undefined, started: number, status: string): void {
	trace?.mark("lease.end", { durationMs: performance.now() - started, status });
}
