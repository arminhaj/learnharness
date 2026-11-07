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
        assert.match(prompt, /write, complete, modify, or debug C\+\+ code/);
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
