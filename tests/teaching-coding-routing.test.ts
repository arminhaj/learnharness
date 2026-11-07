import assert from "node:assert/strict";
import { test } from "node:test";
import { teachAskToolFor, createTeacherTools, type TeacherToolContext } from "../src/agent/tools.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { CODE_DEMO_EXERCISE } from "../src/core/code-workspace.ts";
import { derivePlanStatuses, derivePlanStatusesLh, type PlanTree } from "../src/core/contracts/plan.ts";
import { phaseAt3, phaseAt3Lh, teachStepIndex } from "../src/core/phases.ts";
import { parseAskInput } from "../src/core/tool-parts.ts";
import { questionNeedsReveal } from "../src/core/question-core.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const tree: PlanTree = { nodes: [{ id: "mutex", title: "Mutex ownership" }, { id: "admission", title: "Implement admission" }], edges: [], version: 1 };
const question = { question: "Complete the implementation.", nodeId: "admission", codeExercise: { ...CODE_DEMO_EXERCISE, language: "cpp" as const } };
const ctx = { chatId: "lesson", chatStore: { getChat: () => ({ tree }) }, jobStore: {}, spawn: () => {} } as unknown as TeacherToolContext;

function message(name: string, args: unknown): LhMessage {
    return { id: "coding-question", role: "assistant", content: [{ type: "toolCall", id: "code", name, arguments: args }], timestamp: 1, stopReason: "toolUse" } as LhMessage;
}

test("both teaching profiles expose and validate the coding route on the current lesson", async () => {
    for (const profile of [undefined, "focused"] as const) {
        const registry = createTeacherTools(ctx, undefined, profile);
        const ask = registry.ask_user_question!;
        assert.ok((await ask.execute("code", question, undefined, undefined)));
        const wrongNode = await ask.execute("code", { ...question, nodeId: "other-lesson" }, undefined, undefined);
        assert.equal(wrongNode.isError, true);
        const prompt = composeInstructions("teacher", undefined, profile);
        assert.match(prompt, /## Hands-on coding within the lesson/);
        assert.match(prompt, /write, complete, modify, or debug code in an executable language/);
        assert.match(prompt, /`cpp` \(C\+\+20\)[\s\S]*`python` \(Python 3\.11\+\)/);
        assert.match(prompt, /passing check alone does not complete/);
    }
    const ask = teachAskToolFor(ctx);
    const offPlan = { ...question, nodeId: undefined };
    assert.notEqual((await ask.execute("code", offPlan, undefined, undefined)).isError, true);
    assert.deepEqual(parseAskInput(question), question);
    assert.equal(questionNeedsReveal("ask_user_question", question, "teach"), false);
});

test("coding starts teaching and advances plan position without marking completion", () => {
    const parts = [{ type: "tool-explain", input: { nodeId: "mutex" } }, { type: "tool-ask_user_question", input: question }];
    const before = JSON.stringify(tree);
    const status = derivePlanStatuses(tree, [{ parts }]);
    assert.equal(status.current, "admission");
    assert.deepEqual([...status.visited], ["mutex"]);
    const native = [message("explain", { nodeId: "mutex" }), message("ask_user_question", question)];
    assert.deepEqual(derivePlanStatusesLh(tree, native), status);
    assert.equal(JSON.stringify(tree), before);
    const codingPart = parts[1]!;
    assert.equal(phaseAt3([{ parts: [codingPart] }], undefined, "plan"), "teach");
    assert.equal(phaseAt3Lh([native[1]!], undefined, "plan"), "teach");
    assert.equal(teachStepIndex([{ type: "step-start" }, { type: "text" }, { type: "step-start" }, codingPart]), 2);
});

test("ordinary questions and malformed coding payloads cannot move the lesson", () => {
    for (const input of [{ question: "Which direction?", nodeId: "admission" }, { ...question, codeExercise: { language: "cpp", starterCode: "", tests: [] } }]) {
        const parts = [{ type: "tool-ask_user_question", input }];
        assert.equal(derivePlanStatuses(tree, [{ parts }]).current, null);
        assert.equal(derivePlanStatusesLh(tree, [message("ask_user_question", input)]).current, null);
        assert.equal(phaseAt3([{ parts }], undefined, "plan"), "plan");
        assert.equal(phaseAt3Lh([message("ask_user_question", input)], undefined, "plan"), "plan");
    }
});

test("native plan-linked coding compares the step's language with the exercise through the catalog", async () => {
    const planned = (language?: string): TeacherToolContext => ({
        chatId: "lesson", jobStore: {}, spawn: () => {},
        chatStore: { getChat: () => ({ tree: { nodes: [{ id: "step", title: "Step", ...(language ? { coding: { goal: "g", mode: "problem", language } } : {}) }], edges: [], version: 1 } }) },
    } as unknown as TeacherToolContext);
    const ask = (ctxFor: TeacherToolContext, language: string, nodeId: string | null = "step") =>
        teachAskToolFor(ctxFor).execute("code", { question: "Write it.", ...(nodeId ? { nodeId } : {}), codeExercise: { ...CODE_DEMO_EXERCISE, language: language as "cpp" } }, undefined, undefined);
    // A Python step accepts Python, including by alias; a C++ exercise on it is rejected.
    for (const [stepLanguage, exerciseLanguage] of [["python", "python"], ["py", "python"], ["python3", "python"], ["PYTHON", "python"], ["cpp", "cpp"], ["c++", "cpp"], ["cxx", "cpp"]] as [string, string][]) {
        assert.notEqual((await ask(planned(stepLanguage), exerciseLanguage)).isError, true, `${stepLanguage} step accepts ${exerciseLanguage}`);
    }
    for (const [stepLanguage, exerciseLanguage] of [["python", "cpp"], ["py", "cpp"], ["cpp", "python"], ["c++", "python"]] as [string, string][]) {
        const result = await ask(planned(stepLanguage), exerciseLanguage);
        assert.equal(result.isError, true, `${stepLanguage} step rejects ${exerciseLanguage}`);
        assert.match((result.details as { problems: string[] }).problems.join(" "), /calls for/);
    }
    // Steps without an explicit language stay permissive, and off-plan exercises are unaffected.
    assert.notEqual((await ask(planned(), "python")).isError, true);
    assert.notEqual((await ask(planned(), "cpp")).isError, true);
    assert.notEqual((await ask(planned("python"), "cpp", null)).isError, true, "off-plan (no nodeId) ignores plan languages");
    const unknown = await ask(planned("python"), "cpp", "missing-node");
    assert.equal(unknown.isError, true, "an unknown node id is still rejected for its own reason");
});
