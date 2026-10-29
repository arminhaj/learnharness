/** Public progress contains counts and activity only. Model text, reasoning,
 * tool arguments/results, source passages and provider payloads never ride here. */
export type ExtractionActivity = "waiting" | "thinking" | "responding" | "tool" | "saving";

export interface ModelStreamProgress {
	activity: Exclude<ExtractionActivity, "saving">;
	/** Time of the last actual stream/tool event. Zero until one is observed. */
	lastActivityAt: number;
	/** Time the current model request began, excluding capacity queue time. */
	requestStartedAt?: number;
	modelTurn: number;
	maxModelTurns: number;
	/** Normalized provider events received in this batch, across model turns. */
	receivedEvents: number;
	/** Delta character count (text, reasoning and tool-call JSON), not tokens. */
	outputChars: number;
	/** Only a known built-in tool id; never a model-supplied label. */
	toolName?: string;
}

export interface ExtractionProgress extends Omit<ModelStreamProgress, "activity"> {
	activity: ExtractionActivity;
	sourceStartedAt: number;
	batch: { current: number; total: number; completed: number };
	lastSavedAt?: number;
	/** Unique concepts, prerequisite pairs and groups saved during this update. */
	saved?: { nodes: number; prerequisites: number; groups: number };
}

/** Deliberately metadata-shaped; the adapter must discard provider content. */
export type ModelProgressEvent =
	| { kind: "turn-start" }
	| { kind: "stream-start" | "stream-end" }
	| { kind: "thinking" | "responding"; characters?: number; toolName?: string }
	| { kind: "tool"; toolName?: string };

const KNOWN_PROGRESS_TOOLS = new Set([
	"find_learning_concepts", "submit_learning_map", "submit_findings", "submit_review",
	"find", "list_sessions", "list_propositions",
]);

export function safeProgressToolName(value: string | undefined): string | undefined {
	return value !== undefined && KNOWN_PROGRESS_TOOLS.has(value) ? value : undefined;
}

export function initialModelProgress(maxModelTurns: number): ModelStreamProgress {
	return { activity: "waiting", lastActivityAt: 0, modelTurn: 0, maxModelTurns, receivedEvents: 0, outputChars: 0 };
}

export function advanceModelProgress(current: ModelStreamProgress, event: ModelProgressEvent, at: number): ModelStreamProgress {
	if (event.kind === "turn-start") return {
		...current, activity: "waiting", toolName: undefined,
		requestStartedAt: at,
		modelTurn: Math.min(current.modelTurn + 1, current.maxModelTurns),
	};
	const providerEvent = event.kind !== "tool";
	const characters = "characters" in event && Number.isFinite(event.characters) ? Math.max(0, event.characters ?? 0) : 0;
	return {
		...current,
		activity: event.kind === "stream-start" ? "waiting" : event.kind === "stream-end" ? current.activity : event.kind,
		lastActivityAt: at,
		receivedEvents: current.receivedEvents + (providerEvent ? 1 : 0),
		outputChars: current.outputChars + characters,
		toolName: "toolName" in event ? safeProgressToolName(event.toolName) : undefined,
	};
}
