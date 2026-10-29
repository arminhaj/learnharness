import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { problemInputObject, problemTool, type ProblemInput } from "../src/agent/tools/practice.ts";
import { CODE_SOURCE_LIMIT, CODE_TEST_LIMIT, CODE_TEST_TEXT_LIMIT, type CodeExercise } from "../src/core/code-workspace.ts";

const plainProblem: ProblemInput = {
	statement: "Explain why adding two odd integers gives an even integer.",
	mode: "recall",
	modelSolution: "Write each odd integer as twice an integer plus one, then factor out two from their sum.",
};

const exercise: CodeExercise = {
	language: "cpp",
	starterCode: "#include <iostream>\nint twice(int n) { return 0; }\nint main() { int n; std::cin >> n; std::cout << twice(n) << '\\n'; }\n",
	tests: [
		{ name: "Positive input", stdin: "3\n", expectedStdout: "6\n" },
		{ name: "Negative input", stdin: "-2\n", expectedStdout: "-4\n" },
	],
};

const codingProblem = { ...plainProblem, statement: "Implement twice(n). Read one integer and print twice its value.", codeExercise: exercise };

function validate(arguments_: unknown): ProblemInput {
	return validateToolArguments(
		{ name: "problem", parameters: problemInputObject } as never,
		{ id: "pose", type: "toolCall", name: "problem", arguments: arguments_ } as never,
	) as ProblemInput;
}

describe("practice coding exercise authoring", () => {
	it("ordinary problems still validate and open the problem without code metadata", async () => {
		const gate = { problemActive: false };
		const input = validate(plainProblem);
		const result = await problemTool(gate).execute("plain", input);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
		assert.equal(gate.problemActive, true);
		assert.equal(input.codeExercise, undefined);
	});

	it("a complete coding problem preserves starter source and cases through argument validation", async () => {
		const gate = { problemActive: false };
		const input = validate(codingProblem);
		assert.deepEqual(input.codeExercise, exercise);
		const result = await problemTool(gate).execute("code", input);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
		assert.equal(gate.problemActive, true);
	});

	it("the language field stays extensible while runtime rejects unsupported execution", async () => {
		const gate = { problemActive: false };
		const tool = problemTool(gate);
		const input = validate({ ...codingProblem, codeExercise: { ...exercise, language: "python" } });
		const result = await tool.execute("unsupported", input);
		assert.equal(result.isError, true);
		assert.match((result.details as { problems: string[] }).problems[0]!, /C\+\+.*cpp/);
		assert.equal(gate.problemActive, false);
		const retry = await tool.execute("supported", validate(codingProblem));
		assert.equal(retry.isError, undefined, "correcting the language can pose again in the same turn");
	});

	it("the tool schema rejects missing or malformed test fields and generated commands", () => {
		for (const codeExercise of [
			{ ...exercise, tests: [{ name: "Incomplete", stdin: "3" }] },
			{ ...exercise, tests: [{ name: "Wrong type", stdin: { value: 3 }, expectedStdout: "6" }] },
			{ ...exercise, compileCommand: "compiler solution.cpp" },
			{ ...exercise, tests: [{ ...exercise.tests[0], command: "run-program" }] },
		]) {
			assert.throws(() => validate({ ...codingProblem, codeExercise }));
		}
	});

	for (const [label, codeExercise] of Object.entries({
		"blank source": { ...exercise, starterCode: " \n\t" },
		"oversized UTF-8 source": { ...exercise, starterCode: "é".repeat(CODE_SOURCE_LIMIT / 2 + 1) },
		"no test cases": { ...exercise, tests: [] },
		"too many cases": { ...exercise, tests: Array.from({ length: CODE_TEST_LIMIT + 1 }, () => exercise.tests[0]) },
		"blank test name": { ...exercise, tests: [{ ...exercise.tests[0], name: " " }] },
		"oversized test name": { ...exercise, tests: [{ ...exercise.tests[0], name: "x".repeat(121) }] },
		"oversized UTF-8 input": { ...exercise, tests: [{ ...exercise.tests[0], stdin: "é".repeat(CODE_TEST_TEXT_LIMIT / 2 + 1) }] },
		"oversized UTF-8 expected output": { ...exercise, tests: [{ ...exercise.tests[0], expectedStdout: "é".repeat(CODE_TEST_TEXT_LIMIT / 2 + 1) }] },
	})) {
		it(`rejects ${label} before arming the problem gate`, async () => {
			const gate = { problemActive: false };
			const result = await problemTool(gate).execute("invalid", { ...codingProblem, codeExercise } as ProblemInput);
			assert.equal(result.isError, true);
			assert.match((result.details as { problems: string[] }).problems[0]!, /^codeExercise:/);
			assert.equal(gate.problemActive, false);
		});
	}
});
