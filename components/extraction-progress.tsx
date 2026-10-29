"use client";

import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import type { ExtractionProgress } from "@/src/core";
import type { ServerConnectionStatus } from "./server-events";
import { cn } from "@/lib/utils";

export interface ExtractionProgressRun {
	phase?: string;
	startedAt: number;
	part?: { i: number; n: number };
	progress?: ExtractionProgress;
	/** The last HTTP status read failed; cached values are not live evidence. */
	progressUnavailable?: boolean;
}

/** A wall clock independent of server events, so quiet providers still age. */
export function useActivityNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const phaseLabels: Record<string, string> = {
	queued: "Queued", waiting: "Waiting", extracting: "Extracting", auditing: "Checking concepts", merging: "Saving", embedding: "Arranging graph",
};
const activityLabels: Record<ExtractionProgress["activity"], string> = {
	waiting: "Waiting for model", thinking: "Model thinking", responding: "Receiving response", tool: "Using a tool", saving: "Saving map",
};
const toolLabels: Record<string, string> = { find_learning_concepts: "Searching concepts", submit_learning_map: "Submitting map" };
export const QUIET_MODEL_NOTE = "Long reasoning may be silent; this does not confirm a stall.";

export function describeExtractionProgress(run: ExtractionProgressRun, now: number, connection: ServerConnectionStatus = "unknown") {
	const progress = run.progress;
	const elapsed = formatElapsed(now - (progress?.sourceStartedAt ?? run.startedAt));
	const connectionNote = run.progressUnavailable ? "Progress unavailable — showing the last update"
		: connection === "reconnecting" ? "Reconnecting — progress may be out of date" : connection === "connecting" ? "Connecting — progress may be out of date" : null;
	if (!progress) return {
		phase: phaseLabels[run.phase ?? ""] ?? run.phase ?? "Running",
		elapsed, connectionNote, quiet: false, activityAge: null, activityLine: null,
		batch: run.part ? `Batch ${run.part.i}/${run.part.n}` : null,
		completed: null, modelStep: null, events: null, characters: null, saved: null, lastSaved: null,
	};
	// Response waiting starts at dispatch, excluding time queued for capacity.
	// Older payloads fall back to the batch start; total elapsed is source-wide.
	const activityAge = Math.max(0, now - (progress.lastActivityAt > 0 ? progress.lastActivityAt : progress.requestStartedAt ?? run.startedAt));
	const queued = run.phase === "queued" || run.phase === "waiting";
	const quiet = activityAge >= 120_000 && !queued && !connectionNote && progress.activity !== "saving";
	return {
		phase: queued ? "Waiting for model capacity" : progress.activity === "tool" ? toolLabels[progress.toolName ?? ""] ?? activityLabels.tool : activityLabels[progress.activity],
		elapsed, connectionNote, quiet, activityAge,
		activityLine: queued ? `Queued for ${formatElapsed(now - run.startedAt)}` : connectionNote ? `Last recorded activity ${formatElapsed(activityAge)} ago`
			: quiet ? `No model activity for ${formatElapsed(activityAge)}`
				: progress.lastActivityAt > 0 ? `Last activity ${formatElapsed(activityAge)} ago` : `Waiting ${formatElapsed(activityAge)} for first activity`,
		batch: `Batch ${progress.batch.current}/${progress.batch.total}`,
		completed: `${progress.batch.completed}/${progress.batch.total} batches saved`,
		modelStep: progress.modelTurn > 0 ? `${progress.modelTurn} (limit ${progress.maxModelTurns})` : "Not started",
		events: progress.receivedEvents.toLocaleString("en-US"),
		characters: progress.outputChars.toLocaleString("en-US"),
		saved: progress.saved ? `${progress.saved.nodes} concepts · ${progress.saved.prerequisites} prerequisites · ${progress.saved.groups} groups` : null,
		lastSaved: progress.lastSavedAt ? `${formatElapsed(now - progress.lastSavedAt)} ago` : null,
	};
}

export function ExtractionProgressCompact({ run, now, connection = "unknown" }: { run: ExtractionProgressRun; now: number; connection?: ServerConnectionStatus }) {
	const view = describeExtractionProgress(run, now, connection);
	return <span className="block text-muted-foreground" data-testid="extraction-progress-compact">
		<span className="block truncate" title={[view.phase, view.batch, view.completed].filter(Boolean).join(" · ")}>{view.phase}{view.batch && ` · ${view.batch}`}</span>
		{view.completed && <span className="block truncate">{view.completed}</span>}
		{(view.connectionNote || view.activityLine) && <span className="block leading-relaxed" data-testid="extraction-activity-age">{view.connectionNote ?? view.activityLine}</span>}
		{view.quiet && <span className="mt-1 block leading-relaxed text-muted-foreground/80">{QUIET_MODEL_NOTE}</span>}
	</span>;
}

export function ExtractionProgressDetails({ run, now, connection = "unknown", className }: { run: ExtractionProgressRun; now: number; connection?: ServerConnectionStatus; className?: string }) {
	const view = describeExtractionProgress(run, now, connection);
	return <div className={cn("space-y-2 text-xs text-muted-foreground", className)} data-testid="extraction-progress-details">
		{view.connectionNote && <p className="leading-relaxed">{view.connectionNote}</p>}
		<dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 tabular-nums">
			<dt>Activity</dt><dd className="text-right text-foreground">{view.phase}</dd>
			{view.batch && <><dt>Current batch</dt><dd className="text-right">{view.batch.replace("Batch ", "")}</dd></>}
			{view.completed && <><dt>Saved batches</dt><dd className="text-right">{view.completed.replace(" batches saved", "")}</dd></>}
			<dt>Source elapsed</dt><dd className="text-right">{view.elapsed}</dd>
			{view.modelStep && <><dt>Model step</dt><dd className="text-right">{view.modelStep}</dd></>}
			{view.events !== null && <><dt>Received events</dt><dd className="text-right">{view.events}</dd><dt>Output characters</dt><dd className="text-right">{view.characters}</dd></>}
		</dl>
		{view.events !== null && <p className="text-xs text-muted-foreground/80">Event and character counts cover this batch.</p>}
		{view.activityLine && <p className="leading-relaxed" data-testid="extraction-last-activity">{view.activityLine}</p>}
		{view.quiet && <p className="leading-relaxed" data-testid="extraction-quiet-note">{QUIET_MODEL_NOTE}</p>}
		{view.lastSaved && <div className="border-t border-border/50 pt-2"><p>Last save {view.lastSaved}</p>{view.saved && <p className="mt-1 leading-relaxed" data-testid="extraction-saved-counts">Saved this update: {view.saved}</p>}</div>}
		{!run.progress && <p className="leading-relaxed">This run has not reported detailed progress.</p>}
	</div>;
}

/** The graph keeps the same quiet native surface while exposing real work. */
export function GraphExtractionProgress({ run, now, connection = "unknown" }: { run: ExtractionProgressRun & { title: string }; now: number; connection?: ServerConnectionStatus }) {
	const view = describeExtractionProgress(run, now, connection);
	return <div className="w-80 max-w-full rounded-xl border bg-card/95 p-3 text-xs shadow-lg backdrop-blur" data-testid="graph-extraction-progress">
		<div className="mb-2 flex items-start gap-2"><Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1 break-words text-foreground">{run.title}</span><span className="shrink-0 tabular-nums text-muted-foreground">{view.elapsed}</span></div>
		<ExtractionProgressDetails run={run} now={now} connection={connection} />
	</div>;
}
