import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SourcePassage } from "../components/source-passage.tsx";
import { propositionSessionHref, messageIdFromHash } from "../src/core/session-navigation.ts";

describe("learner evidence passage anchors", () => {
	it("renders the exact target referenced by metadata evidence links", () => {
		for (const nativeId of ["user_1", "answer_quiz_1", "practice_thinking_1"]) {
			const href = propositionSessionHref({ provenance: [{ chatId: "chat_1", messageId: nativeId }] }, "chat_1");
			const id = messageIdFromHash(href.slice(href.indexOf("#")))!;
			const html = renderToStaticMarkup(<SourcePassage messageId={id} className="learner-style" data-testid="learner-evidence">Learner answer</SourcePassage>);
			assert.match(html, new RegExp(`id="message-${nativeId}"`));
			assert.match(html, /lh-source-passage learner-style/);
			assert.match(html, /Learner answer/);
		}
	});
	it("does not create an empty anchor for legacy rows without IDs", () => {
		const html = renderToStaticMarkup(<SourcePassage>Legacy answer</SourcePassage>);
		assert.doesNotMatch(html, /id="/);
	});
});
