import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeCheckResults } from "../components/code-workbench.tsx";
import type { CodeRunResult } from "../src/core/code-workspace.ts";

const result: CodeRunResult = {
	id: "attempt-1", workspaceId: "exercise-1", language: "cpp", source: "int main() {}", revision: "abc", createdAt: "2026-10-29T12:00:00.000Z",
	compiler: "clang++", status: "tests_failed", stdout: "", stderr: "",
	tests: [{ name: "Positive numbers", stdin: "2 3\n", expectedStdout: "5\n", stdout: "0\n", stderr: "", status: "failed", exitCode: 0 }],
};

describe("code check evidence", () => {
	it("keeps successful compilation distinct from failed behavior", () => {
		const html = renderToStaticMarkup(<CodeCheckResults result={result} />);
		assert.match(html, /Compiled · some tests failed/);
		assert.match(html, /0\/1 tests/);
		assert.match(html, /Expected output/);
		assert.match(html, /Actual output/);
		assert.doesNotMatch(html, /All tests passed|Correct solution/);
	});
	it("labels earlier checks when source has changed", () => {
		const html = renderToStaticMarkup(<CodeCheckResults result={result} stale />);
		assert.match(html, /Previous version/);
		assert.match(html, /Check again to test the current version/);
	});
	it("renders compiler output as escaped text and leaves a passed run for tutor review", () => {
		const html = renderToStaticMarkup(<CodeCheckResults result={{ ...result, status: "compilation_error", tests: [], stderr: "error: <script>alert('compiler')</script>" }} />);
		assert.match(html, /Compilation failed/);
		assert.match(html, /&lt;script&gt;/);
		assert.doesNotMatch(html, /<script>/);
		const passing = renderToStaticMarkup(<CodeCheckResults result={{ ...result, status: "passed", tests: [{ ...result.tests[0]!, stdout: "5\n", status: "passed" }] }} />);
		assert.match(passing, /All tests passed/);
		assert.match(passing, /Your tutor will review the solution and reasoning/);
	});
});
