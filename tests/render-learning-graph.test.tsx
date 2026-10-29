import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LearningNodeSidebar, LearningSessionActions, learningMetadataPatch } from "../components/learning-node-sidebar.tsx";
import { LearningIceberg } from "../components/learning-iceberg.tsx";
import type { LearningConcept, LearningGraphSnapshot } from "../src/core/contracts/learning-graph.ts";

function node(id: string, name: string, patch: Partial<LearningConcept> = {}): LearningConcept {
	return { id, name, statement: `${name} statement.`, aliases: [], createdAt: "2026-10-01T00:00:00Z", provenance: [], tags: [], symbols: [], progress: "unassessed", automaticProgress: "unassessed", progressOverride: null, progressEvidence: [], ready: true, unmetPrerequisiteIds: [], depth: 0, future: false, firstEncounteredAt: "2026-10-01T00:00:00Z", ...patch };
}

const calculus = node("n_calculus", "Calculus", { progress: "comfortable", automaticProgress: "comfortable" });
const euler = node("n_euler", "Euler–Lagrange equation", {
	depth: 1,
	future: true,
	firstEncounteredAt: null,
	symbols: [{ notation: "γ", meaning: "Exponential growth factor", aliases: ["\\gamma", "gamma"], provenance: [{ chatId: "chat_1", messageId: "message_1" }] }],
});
const learning: LearningGraphSnapshot = {
	nodes: [calculus, euler],
	prerequisites: [{ id: "p_calculus_euler", from: calculus.id, to: euler.id, explanation: "Differentiation is needed to form the equation.", provenance: [], origin: "automatic" }],
	prerequisiteCorrections: [],
	groups: [
		{ id: "g_math", name: "Mathematics", description: "Foundations", members: [calculus.id], depth: 0, counts: { unassessed: 0, learning: 0, comfortable: 1 }, readyNodeIds: [], blockedNodeIds: [], unlocks: [euler.id] },
		{ id: "g_mechanics", name: "Variational mechanics", description: "Motion from action", members: [euler.id], depth: 1, counts: { unassessed: 1, learning: 0, comfortable: 0 }, readyNodeIds: [euler.id], blockedNodeIds: [], unlocks: [] },
	],
	groupEdges: [{ from: "g_math", to: "g_mechanics", prerequisiteIds: ["p_calculus_euler"] }],
	cycles: [],
};
const actions = { onClose() {}, onSelect() {}, async onSave() {}, async onPrerequisiteChange() {} };

describe("learning graph details", () => {
	it("renaming does not accidentally override automatically updated symbols or tags", () => {
		assert.deepEqual(learningMetadataPatch({ name: " New name ", tags: "calculus", symbols: euler.symbols }, { name: true }), { name: "New name" });
		assert.deepEqual(learningMetadataPatch({ name: "Same", tags: " mechanics, mechanics, action ", symbols: [] }, { tags: true }), { tags: ["mechanics", "action"] });
	});
	it("symbol corrections retain introduction provenance and normalize aliases", () => {
		const symbols = [{ ...euler.symbols[0]!, aliases: [" gamma ", "", "gamma", "\\gamma"] }];
		const patch = learningMetadataPatch({ name: euler.name, tags: "", symbols }, { symbols: true });
		assert.deepEqual(patch.symbols?.[0]?.aliases, ["gamma", "\\gamma"]);
		assert.deepEqual(patch.symbols?.[0]?.provenance, euler.symbols[0]?.provenance);
		assert.equal(patch.progress, undefined);
	});
	it("shows readiness independently of understanding and future concepts independently of history", () => {
		const html = renderToStaticMarkup(<LearningNodeSidebar node={euler} learning={learning} {...actions} sessions={{ chat_1: "Growth conversation" }} />);
		assert.match(html, /Ready to learn: all recorded prerequisites are comfortable/);
		assert.match(html, /value="unassessed" selected=""/);
		assert.match(html, /Not encountered yet/);
		assert.match(html, /Added to map/);
		assert.match(html, /No understanding evidence yet/);
		assert.match(html, /\/chat\/chat_1#message-message_1/);
		assert.match(html, /Growth conversation/);
	});
	it("explains and exposes resetting a personal correction and removed prerequisite", () => {
		const corrected = { ...euler, progress: "learning" as const, progressOverride: "learning" as const };
		const snapshot = { ...learning, prerequisites: [], prerequisiteCorrections: [{ from: calculus.id, to: euler.id, enabled: false }] };
		const html = renderToStaticMarkup(<LearningNodeSidebar node={corrected} learning={snapshot} {...actions} />);
		assert.match(html, /Your correction is active/);
		assert.match(html, /Use automatic · Unassessed/);
		assert.match(html, /Removed prerequisites/);
		assert.match(html, /Calculus/);
	});
	it("preserved evidence from a deleted session does not create a broken conversation link", () => {
		const html = renderToStaticMarkup(<LearningNodeSidebar node={euler} learning={learning} {...actions} sessions={{}} />);
		assert.match(html, /Source unavailable/);
		assert.match(html, /Exponential growth factor/);
		assert.doesNotMatch(html, /href="\/chat\/chat_1/);
	});
});

describe("concept teaching and assessment actions", () => {
	const button = (html: string, id: string) => html.match(new RegExp(`<button(?=[^>]*data-testid="${id}")[^>]*>`))?.[0] ?? assert.fail(`Missing ${id}`);
	it("offers learning and testing for every understanding state without changing it", () => {
		for (const progress of ["unassessed", "learning", "comfortable"] as const) {
			const concept = { ...euler, progress };
			const html = renderToStaticMarkup(<LearningNodeSidebar node={concept} learning={learning} {...actions} onStartSession={async () => {}} />);
			assert.match(html, /Learn this concept/);
			assert.match(html, /Test my understanding/);
			assert.doesNotMatch(button(html, "learn-concept"), /disabled=""/);
			assert.doesNotMatch(button(html, "test-concept"), /disabled=""/);
			assert.match(html, new RegExp(`value="${progress}" selected=""`));
			assert.equal(concept.progress, progress);
		}
	});
	it("explains prerequisite checks while allowing both sessions", () => {
		const concept = { ...euler, ready: false, unmetPrerequisiteIds: [calculus.id] };
		const html = renderToStaticMarkup(<LearningNodeSidebar node={concept} learning={learning} {...actions} onStartSession={async () => {}} />);
		assert.match(html, /The session will check prerequisite gaps first/);
		assert.doesNotMatch(button(html, "learn-concept"), /disabled=""/);
		assert.doesNotMatch(button(html, "test-concept"), /disabled=""/);
	});
	it("protects unsaved edits and pending metadata writes from navigation", () => {
		for (const state of [{ dirty: true }, { busy: true }]) {
			const html = renderToStaticMarkup(<LearningSessionActions onStart={() => {}} onDiscardDraft={() => {}} {...state} />);
			assert.match(button(html, "learn-concept"), /disabled=""/);
			assert.match(button(html, "test-concept"), /disabled=""/);
			if ("dirty" in state) {
				assert.match(html, /Save or discard your edits before starting a session/);
				assert.match(html, /Discard unsaved edits/);
			}
		}
	});
	it("disables both launches and metadata edits while a session starts", () => {
		const html = renderToStaticMarkup(<LearningNodeSidebar node={euler} learning={learning} {...actions} onStartSession={async () => {}} sessionStarting="practice" />);
		assert.match(html, /Starting practice…/);
		assert.match(button(html, "learn-concept"), /disabled=""/);
		assert.match(button(html, "test-concept"), /disabled=""/);
		assert.match(html, /<input(?=[^>]*maxLength="200")(?=[^>]*disabled="")[^>]*>/);
	});
	it("shows creation errors beside retryable actions and keeps legacy callers usable", () => {
		const html = renderToStaticMarkup(<LearningNodeSidebar node={euler} learning={learning} {...actions} onStartSession={async () => {}} sessionError="Choose a teaching model first." />);
		assert.match(html, /role="alert"[^>]*>Choose a teaching model first/);
		assert.doesNotMatch(button(html, "learn-concept"), /disabled=""/);
		const legacy = renderToStaticMarkup(<LearningNodeSidebar node={euler} learning={learning} {...actions} />);
		assert.doesNotMatch(legacy, /data-testid="learning-session-actions"/);
	});
});

describe("learning iceberg", () => {
	it("shows foundations, actual prerequisite groups, progress, and unlocks without marking ready nodes understood", () => {
		const html = renderToStaticMarkup(<LearningIceberg learning={learning} selectedId={euler.id} onSelect={() => {}} />);
		assert.match(html, /Foundations/);
		assert.match(html, /Depth 1/);
		assert.match(html, /Builds on Mathematics/);
		assert.match(html, /Comfort with this group unlocks/);
		assert.match(html, /0 comfortable, 0 learning, 1 unassessed/);
		assert.match(html, /aria-pressed="true"/);
		assert.match(html, /1 ready to learn/);
	});
	it("filters node rows and explains when no concepts match", () => {
		const html = renderToStaticMarkup(<LearningIceberg learning={learning} selectedId={null} visibleIds={new Set()} onSelect={() => {}} />);
		assert.match(html, /No concepts match this search/);
		assert.doesNotMatch(html, /learning-group-g_math/);
	});
	it("keeps concepts without an automatic group available without inventing a depth", () => {
		const html = renderToStaticMarkup(<LearningIceberg learning={{ ...learning, groups: [], groupEdges: [] }} selectedId={null} onSelect={() => {}} />);
		assert.match(html, /Not grouped yet/);
		assert.match(html, /Euler–Lagrange equation/);
		assert.doesNotMatch(html, /aria-label="Foundations"/);
	});
});
