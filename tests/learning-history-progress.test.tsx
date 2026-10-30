import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryRunProgress } from "../components/learning-history.tsx";
import { historyErrorMessage, type HistoryRunStatus } from "../src/core/learning-history.ts";

const status: HistoryRunStatus = { running: true, total: 16, completed: 2, succeeded: 0, failed: 2, cancelled: 0, skipped: 0, stage: "finding" };
test("progress distinguishes attempts, successful analyses and failures, including after completion", () => {
	const running = renderToStaticMarkup(<HistoryRunProgress status={status} title="Physics" />);
	assert.match(running, /0 successful · 2 failed · 14 remaining/);
	assert.doesNotMatch(running, /2.*sessions finished/);
	assert.match(running, /Finding learning episodes · Physics/);
	const finished = renderToStaticMarkup(<HistoryRunProgress status={{ ...status, running: false, total: 2 }} />);
	assert.match(finished, /Update complete: 0 successful · 2 failed/);
	assert.doesNotMatch(finished, /remaining|Finding learning episodes/);
});
test("stopping an update does not label interrupted or queued sessions as failed", () => {
	const html = renderToStaticMarkup(<HistoryRunProgress status={{ ...status, running: false, stopped: true, succeeded: 1, failed: 0, cancelled: 1 }} />);
	assert.match(html, /Update stopped: 1 successful · 0 failed · 1 interrupted · 14 not attempted/);
	assert.match(html, /Completed work is saved/);
});
test("provider handoff errors and refusals have distinct plain-language explanations", () => {
	assert.match(historyErrorMessage("claude CLI moved on without admitting its harness tool calls"), /handoff/);
	assert.match(historyErrorMessage("The model refused to complete the request"), /declined/);
	assert.match(historyErrorMessage("API Error: Opus 5.5's safeguards flagged this message"), /declined/);
});
