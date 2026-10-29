import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExtractionProgress } from "../src/core/index.ts";
import { ActivityBlobRow, toBlobs, type FeedExtraction } from "../components/activity-dock.tsx";
import { describeExtractionProgress, ExtractionProgressDetails, GraphExtractionProgress, QUIET_MODEL_NOTE } from "../components/extraction-progress.tsx";

const now = Date.parse("2026-10-28T12:00:00Z");
const progress: ExtractionProgress = {
	activity: "thinking", lastActivityAt: now - 4_000, modelTurn: 2, maxModelTurns: 8,
	receivedEvents: 1234, outputChars: 56789, sourceStartedAt: now - 600_000,
	batch: { current: 2, total: 4, completed: 1 }, lastSavedAt: now - 180_000,
	saved: { nodes: 7, prerequisites: 5, groups: 2 },
};
const run: FeedExtraction = { id: "chat_1#2", chatId: "chat_1", title: "Learning map · Mechanics", phase: "extracting", startedAt: now - 190_000, progress };

describe("observable map progress", () => {
	it("shows actual model activity, batch completion, source elapsed and counters", () => {
		const view = describeExtractionProgress(run, now, "connected");
		assert.equal(view.phase, "Model thinking");
		assert.equal(view.batch, "Batch 2/4");
		assert.equal(view.completed, "1/4 batches saved");
		assert.equal(view.elapsed, "10m 00s");
		assert.equal(view.activityLine, "Last activity 4s ago");
		assert.equal(view.events, "1,234");
		assert.equal(view.characters, "56,789");
		assert.equal(view.quiet, false);
		const html = renderToStaticMarkup(<GraphExtractionProgress run={run} now={now} connection="connected" />);
		assert.match(html, /Saved batches/);
		assert.match(html, /1\/4/);
		assert.match(html, /Output characters/);
		assert.match(html, /Last save 3m 00s ago/);
		assert.match(html, /7 concepts · 5 prerequisites · 2 groups/);
		assert.doesNotMatch(html, /%|timed out|timeout/i);
	});

	it("ages a silent provider without needing a new event and never diagnoses a stall", () => {
		const later = now + 120_000;
		const view = describeExtractionProgress(run, later, "connected");
		assert.equal(view.activityLine, "No model activity for 2m 04s");
		assert.equal(view.elapsed, "12m 00s");
		assert.equal(view.quiet, true);
		const html = renderToStaticMarkup(<ExtractionProgressDetails run={run} now={later} connection="connected" />);
		assert.ok(html.includes(QUIET_MODEL_NOTE));
		assert.doesNotMatch(html, /timed out|has stalled/i);
		assert.equal(describeExtractionProgress({ ...run, progress: { ...progress, lastActivityAt: later } }, later).quiet, false);
	});

	it("distinguishes waiting for capacity from a model that has gone quiet", () => {
		for (const phase of ["queued", "waiting"]) {
			const view = describeExtractionProgress({ ...run, phase, progress: { ...progress, activity: "waiting", lastActivityAt: 0 } }, now);
			assert.equal(view.phase, "Waiting for model capacity");
			assert.equal(view.activityLine, "Queued for 3m 10s");
			assert.equal(view.quiet, false);
		}
	});

	it("uses the current batch start for initial response wait, not the whole source duration", () => {
		const view = describeExtractionProgress({ ...run, startedAt: now - 5_000, progress: { ...progress, activity: "waiting", lastActivityAt: 0 } }, now);
		assert.equal(view.activityLine, "Waiting 5s for first activity");
		assert.equal(view.elapsed, "10m 00s");
		assert.equal(view.quiet, false);
	});

	it("excludes a long capacity queue from initial-response waiting after dispatch", () => {
		const view = describeExtractionProgress({ ...run, startedAt: now - 190_000, progress: { ...progress, activity: "waiting", lastActivityAt: 0, requestStartedAt: now - 2_000 } }, now);
		assert.equal(view.phase, "Waiting for model");
		assert.equal(view.activityLine, "Waiting 2s for first activity");
		assert.equal(view.quiet, false, "a model dispatched two seconds ago is not silent for the preceding queue duration");
	});

	it("shows known search/submission activity without revealing arbitrary tool details", () => {
		assert.equal(describeExtractionProgress({ ...run, progress: { ...progress, activity: "tool", toolName: "find_learning_concepts" } }, now).phase, "Searching concepts");
		assert.equal(describeExtractionProgress({ ...run, progress: { ...progress, activity: "tool", toolName: "submit_learning_map" } }, now).phase, "Submitting map");
		assert.equal(describeExtractionProgress({ ...run, progress: { ...progress, activity: "tool", toolName: "private payload" } }, now).phase, "Using a tool");
	});

	it("separates broken transport or status reads from model silence", () => {
		const reconnecting = describeExtractionProgress(run, now + 120_000, "reconnecting");
		assert.equal(reconnecting.connectionNote, "Reconnecting — progress may be out of date");
		assert.equal(reconnecting.quiet, false);
		assert.match(reconnecting.activityLine!, /Last recorded activity/);
		const unavailable = describeExtractionProgress({ ...run, progressUnavailable: true }, now + 120_000, "connected");
		assert.equal(unavailable.connectionNote, "Progress unavailable — showing the last update");
		assert.equal(unavailable.quiet, false);
	});

	it("handles older payloads without invented activity or counters", () => {
		const legacy = { ...run, progress: undefined, phase: "auditing", part: { i: 1, n: 3 } };
		const view = describeExtractionProgress(legacy, now);
		assert.equal(view.phase, "Checking concepts");
		assert.equal(view.elapsed, "3m 10s");
		assert.equal(view.activityLine, null);
		assert.equal(view.events, null);
		const html = renderToStaticMarkup(<ExtractionProgressDetails run={legacy} now={now} />);
		assert.match(html, /not reported detailed progress/);
		assert.doesNotMatch(html, /Received events|No model activity|Saved batches/);
	});

	it("keeps useful progress visible on collapsed activity rows and details expandable", () => {
		const blob = toBlobs({ jobs: [], extractions: [run] })[0]!;
		assert.deepEqual(blob.progress, progress);
		const props = { blob, now, connection: "connected" as const, onToggleDetail() {}, abortState: undefined, onAbort() {} };
		const collapsed = renderToStaticMarkup(<ActivityBlobRow {...props} detailOpen={false} />);
		assert.match(collapsed, /Model thinking/);
		assert.match(collapsed, /Batch 2\/4/);
		assert.match(collapsed, /1\/4 batches saved/);
		assert.match(collapsed, /Last activity 4s ago/);
		assert.doesNotMatch(collapsed, /Received events/);
		const expanded = renderToStaticMarkup(<ActivityBlobRow {...props} detailOpen />);
		assert.match(expanded, /Received events/);
		assert.match(expanded, /56,789/);
		assert.match(expanded, /Saved this update/);
	});
});
