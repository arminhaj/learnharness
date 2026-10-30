import assert from "node:assert/strict";
import { test } from "node:test";
import { fenceCode, readCodeFence } from "../src/core/code-text.ts";
import { parseChatInput } from "../src/core/input-events.ts";
import { newThinkingMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import type { CodeRunResult } from "../src/core/code-workspace.ts";
import { resolveCheckedCodeInput } from "../src/server/code-submission.ts";

const result: CodeRunResult = { id: "run-1", workspaceId: "workspace-1", source: "int main() { return 1; }", revision: "revision-1", language: "cpp", status: "runtime_error", compiler: "clang++ -std=c++20", stdout: "", stderr: "", tests: [{ name: "Sample", stdin: "", expectedStdout: "ok", stdout: "", stderr: "", exitCode: 1, status: "runtime_error" }], createdAt: "2026-10-29T12:00:00Z" };

test("code answers round-trip whitespace and embedded Markdown fences", () => {
	for (const source of ["  return a + b;\n", 'auto text = "```";\n\t// ````', "int main() {}"] ) {
		assert.equal(readCodeFence(fenceCode(source))?.source, source);
	}
	assert.equal(fenceCode(""), "");
	assert.equal(fenceCode("  \n").trim(), "");
	assert.equal(readCodeFence("ordinary text"), null);
});

test("submission parser drops client verdicts and resolves the actual checked source", async () => {
	const input = parseChatInput({ type: "thinking", problemCallId: "p1", text: "I passed all tests", codeRunId: "run-1", codeResult: { ...result, status: "passed" } });
	assert.equal(input.type === "thinking" && input.codeResult, undefined);
	const resolved = await resolveCheckedCodeInput("chat1", input, (chat, problem, id) => {
		assert.deepEqual([chat, problem, id], ["chat1", "p1", "run-1"]);
		return result;
	});
	assert.equal(resolved.type, "thinking");
	if (resolved.type !== "thinking") return;
	assert.equal(resolved.codeResult, result);
	assert.match(resolved.text, /runtime_error/);
	assert.match(resolved.text, /int main/);
	assert.doesNotMatch(resolved.text, /I passed all tests/);
	const message = newThinkingMessage("p1", resolved.text, resolved.codeResult);
	const view = projectView([message]);
	assert.deepEqual(view[0]?.parts[0]?.data, message.details);
	assert.equal((message.details as { codeResult: CodeRunResult }).codeResult.source, result.source);
});

test("stale checks cannot fall back to the learner's unverified text", async () => {
	await assert.rejects(resolveCheckedCodeInput("chat1", { type: "thinking", problemCallId: "p1", codeRunId: "run-1", text: "passed" }, () => { throw new Error("Source changed since this check"); }), /Source changed/);
	assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p1", text: "answer", codeRunId: {} }), /valid check ID/);
});
