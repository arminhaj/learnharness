import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { lessonProgress } from "../src/core/lesson-progress.ts";
import { LessonProgressRing } from "../components/lesson-progress-ring.tsx";
import { planTreeToText } from "../src/core/compaction.ts";
import { latestTree } from "../components/plan-block.tsx";
const tree = { nodes: [{ id: "a", title: "First" }, { id: "b", title: "Last" }], edges: [], version: 1 };
test("completion ignores visits, duplicates, and removed nodes; handles 0 and 100", () => {
 assert.equal(lessonProgress(null).percent, 0);
 assert.equal(lessonProgress(tree).percent, 0);
 assert.equal(lessonProgress({ ...tree, completedNodeIds: ["a", "a", "gone"] }).percent, 50);
 assert.equal(lessonProgress({ ...tree, completedNodeIds: ["a", "b"] }).percent, 100);
});
test("successful completion updates drive the header after transcript reload", () => {
 const completed = { ...tree, completedNodeIds: ["a", "b"] };
 const messages = [{ parts: [{ type: "tool-plan_init", state: "output-available", output: { tree } }, { type: "tool-plan_set_completed", state: "output-available", output: { ok: true, tree: completed } }] }];
 const restored = latestTree(JSON.parse(JSON.stringify(messages)));
 assert.equal(lessonProgress(restored).percent, 100);
 const html = renderToStaticMarkup(<LessonProgressRing tree={restored} />);
 assert.match(html, /100% of lesson completed/);
 assert.doesNotMatch(html, /animate-pulse/);
 assert.match(renderToStaticMarkup(<LessonProgressRing tree={null} />), /Not started/);
});

test("context compaction retains explicit completion independently of position", () => {
 const text = planTreeToText({ ...tree, completedNodeIds: ["a"] }, []);
 assert.match(text!, /First \(a\) \[lesson step complete\]/);
 assert.doesNotMatch(text!, /Last.*complete/);
});
