import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { compactAnswerForModel, type QuestionAnswerData } from "../src/core/question-core.ts";

for (const teachingProfile of ["focused", "mad-max"] as const) {
	test(`a ${teachingProfile} check starts with recall and can be skipped after revealing choices`, async () => {
		const { document, window } = parseHTML("<html><body><main></main></body></html>");
		const globals = {
			React, document, window, HTMLElement: window.HTMLElement,
			MutationObserver: window.MutationObserver,
			IS_REACT_ACT_ENVIRONMENT: true,
			fetch: async () => Response.json({ settings: { agent: { teachingProfile } } }),
		};
		const previous = Object.entries(globals).map(([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
		for (const [key, value] of Object.entries(globals)) {
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		Object.assign(document, { getSelection: () => null, hasFocus: () => false });
		const host = document.querySelector("main")!;
		const root = createRoot(host);
		const submitted: QuestionAnswerData[] = [];
		const button = (label: string) => {
			const match = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
			assert.ok(match, `Expected ${label} button`);
			return match;
		};
		try {
			const { QuestionDock } = await import("../components/question-dock.tsx");
			await act(async () => root.render(<QuestionDock
				expanded phase="teach" toolName="explain" toolCallId="magnitude-check"
				input={{
					question: "How does the squared length change?",
					correctAnswer: "It grows by a factor of four.",
					choiceHints: [{ label: "Quadruples" }, { label: "Doubles" }],
				}}
				onExpand={() => {}}
				onSubmit={(answer) => submitted.push(answer)}
			/>));
			assert.equal(host.querySelector('[aria-label="Answer choices"]'), null);
			assert.ok(button("I don’t know"), "Focused-family learner controls remain available");
			assert.ok(host.textContent?.includes("Relevance"), "Topic feedback remains available");
			await act(async () => button("Show choices").click());
			assert.ok(host.querySelector('[aria-label="Answer choices"]'));
			assert.equal(submitted.length, 0);
			await act(async () => button("Move on").click());
			assert.equal(submitted.length, 1);
			assert.deepEqual(compactAnswerForModel(submitted[0]!), { kind: "explain", dismissed: true });
			assert.equal(submitted[0]?.committed, undefined);
		} finally {
			await act(async () => root.unmount());
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	});
}
