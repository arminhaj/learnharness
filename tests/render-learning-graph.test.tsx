import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { LearningNodeSidebar, LearningSessionActions, learningMetadataPatch } from "../components/learning-node-sidebar.tsx";
import { LearningIceberg, useLearningSubjectSelection } from "../components/learning-iceberg.tsx";
import { learningSubjectId, learningSubjects, scopeLearningGraphToSubject } from "../src/core/learning-subjects.ts";
import type { LearningConcept, LearningGraphSnapshot, LearningNodePatch } from "../src/core/contracts/learning-graph.ts";

function node(id: string, name: string, patch: Partial<LearningConcept> = {}): LearningConcept {
	return { id, name, statement: `${name} statement.`, aliases: [], createdAt: "2026-10-01T00:00:00Z", provenance: [], tags: [], subjects: [], automaticSubjects: [], subjectsOverride: null, symbols: [], progress: "unassessed", automaticProgress: "unassessed", progressOverride: null, progressEvidence: [], ready: true, unmetPrerequisiteIds: [], depth: 0, future: false, firstEncounteredAt: "2026-10-01T00:00:00Z", ...patch };
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
	it("explains subject correction ownership and keeps reset operations independent", async () => {
		const { window, document } = parseHTML("<html><body></body></html>");
		const originalWindow = globalThis.window;
		const originalDocument = globalThis.document;
		const originalActEnvironment = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
		Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const saved: LearningNodePatch[] = [];
		const concept = { ...euler, subjects: ["Mechanics", "Mathematics"], automaticSubjects: ["Mechanics"], subjectsOverride: ["Mechanics", "Mathematics"] };
		try {
			await act(async () => root.render(<LearningNodeSidebar node={concept} learning={learning} {...actions} onSave={async (patch) => { saved.push(patch); }} />));
			assert.match(host.textContent ?? "", /Shared concepts appear only in the subjects listed here/);
			assert.match(host.textContent ?? "", /Your subject correction is active/);
			const resetMetadata = [...host.querySelectorAll("button")].find((button) => button.textContent === "Reset name, tags & symbols");
			assert.ok(resetMetadata);
			await act(async () => { resetMetadata.click(); });
			assert.deepEqual(saved, [{ name: null, tags: null, symbols: null }]);
			assert.equal(host.querySelector<HTMLInputElement>('input[id$="-subjects"]')?.value, "Mechanics, Mathematics");
			const resetSubjects = [...host.querySelectorAll("button")].find((button) => button.textContent === "Use automatic subjects");
			assert.ok(resetSubjects);
			await act(async () => { resetSubjects.click(); });
			assert.deepEqual(saved[1], { subjects: null });
		} finally {
			await act(async () => root.unmount());
			Object.assign(globalThis, { window: originalWindow, document: originalDocument, IS_REACT_ACT_ENVIRONMENT: originalActEnvironment });
		}
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

describe("subject-scoped iceberg", () => {
	const cpp = node("n_cpp", "Pointer ownership", { subjects: ["C++"] });
	const cppUngrouped = node("n_cpp_loose", "Move constructor", { subjects: ["C++"] });
	const mechanics = node("n_mechanics", "Stationary action", { subjects: ["Mechanics"] });
	const mechanicsUngrouped = node("n_mechanics_loose", "Generalized coordinates", { subjects: ["Mechanics"] });
	const shared = node("n_shared", "Numerical approximation", { subjects: ["C++", "Mechanics"] });
	const unassigned = node("n_unassigned", "Unsorted concept");
	const snapshot: LearningGraphSnapshot = {
		...learning,
		nodes: [cpp, cppUngrouped, mechanics, mechanicsUngrouped, shared, unassigned],
		prerequisites: [],
		groups: [
			{ ...learning.groups[0]!, id: "g_cpp", name: "C++ fundamentals", members: [cpp.id, shared.id], unlocks: [] },
			{ ...learning.groups[1]!, id: "g_mechanics", name: "Mechanics foundations", members: [mechanics.id, shared.id], unlocks: [] },
		],
		groupEdges: [],
	};
	const subjects = learningSubjects(snapshot);
	const renderSubject = (label: string, visibleIds?: ReadonlySet<string>) => {
		const id = label === "Unassigned" ? "unassigned" : learningSubjectId(label);
		return renderToStaticMarkup(<LearningIceberg learning={scopeLearningGraphToSubject(snapshot, id)} selectedId={null} onSelect={() => {}} subjects={subjects} subjectId={id} onSubjectChange={() => {}} visibleIds={visibleIds} />);
	};
	it("uses an accessible explicit subject selector without an All bucket", () => {
		const html = renderSubject("C++");
		assert.match(html, /aria-label="Iceberg subject"/);
		assert.match(html, /value="subject:c%2B%2B" selected=""/);
		assert.match(html, /<option value="unassigned">Unassigned · 1<\/option>/);
		assert.doesNotMatch(html, /<option[^>]*>All/);
	});
	it("keeps grouped and ungrouped concept rows within the selected subject", () => {
		const cppHtml = renderSubject("C++");
		assert.match(cppHtml, /Pointer ownership/);
		assert.match(cppHtml, /Move constructor/);
		assert.match(cppHtml, /Numerical approximation/);
		assert.doesNotMatch(cppHtml, /Stationary action|Generalized coordinates|Unsorted concept/);
		const mechanicsHtml = renderSubject("Mechanics");
		assert.match(mechanicsHtml, /Stationary action/);
		assert.match(mechanicsHtml, /Generalized coordinates/);
		assert.match(mechanicsHtml, /Numerical approximation/);
		assert.doesNotMatch(mechanicsHtml, /Pointer ownership|Move constructor|Unsorted concept/);
	});
	it("does not show unrelated search matches and keeps unassigned concepts reachable", () => {
		const scoped = scopeLearningGraphToSubject(snapshot, learningSubjectId("C++"));
		const html = renderSubject("C++", new Set(scoped.nodes.filter((concept) => concept.name.includes("Stationary")).map((concept) => concept.id)));
		assert.match(html, /No concepts match this search/);
		assert.doesNotMatch(html, /Stationary action|Pointer ownership/);
		const unassignedHtml = renderSubject("Unassigned");
		assert.match(unassignedHtml, /Unsorted concept/);
		assert.match(unassignedHtml, /These concepts have no subject assignment yet/);
		assert.doesNotMatch(unassignedHtml, /Stationary action|Pointer ownership/);
	});
	it("remembers the initial subject across earlier arrivals and empty refreshes, falling back only when it disappears", async () => {
		const { window, document } = parseHTML("<html><body></body></html>");
		const originalWindow = globalThis.window;
		const originalDocument = globalThis.document;
		const originalActEnvironment = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
		Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		function Selection({ ids }: { ids: string[] }) {
			const [selected] = useLearningSubjectSelection(ids.map((id) => ({ id })));
			return <span>{selected ?? "empty"}</span>;
		}
		try {
			await act(async () => root.render(<Selection ids={[]} />));
			await act(async () => root.render(<Selection ids={["mechanics"]} />));
			assert.equal(host.textContent, "mechanics");
			await act(async () => root.render(<Selection ids={["cpp", "mechanics"]} />));
			assert.equal(host.textContent, "mechanics", "new earlier subject must not replace the initial selection");
			await act(async () => root.render(<Selection ids={[]} />));
			assert.equal(host.textContent, "empty");
			await act(async () => root.render(<Selection ids={["cpp", "mechanics"]} />));
			assert.equal(host.textContent, "mechanics", "temporary empty data must retain the remembered subject");
			await act(async () => root.render(<Selection ids={["cpp"]} />));
			assert.equal(host.textContent, "cpp");
		} finally {
			await act(async () => root.unmount());
			Object.assign(globalThis, { window: originalWindow, document: originalDocument, IS_REACT_ACT_ENVIRONMENT: originalActEnvironment });
		}
	});
});
