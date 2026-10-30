import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { CODE_DEMO_EXERCISE, parseCodeExercise, type CodeExercise } from "../src/core/code-workspace.ts";
import { codeProcessEnvironment, runCodeExercise } from "../src/server/code-runner.ts";

const compilerAvailable = ["clang++", "g++"].some((command) => spawnSync(command, ["--version"], { timeout: 5_000 }).status === 0);
const local = { skip: !compilerAvailable };
const check = (source: string, exercise: CodeExercise = CODE_DEMO_EXERCISE, options = {}) => runCodeExercise({ workspaceId: "fixture", source, revision: "fixture", exercise }, options);

test("exercise contracts canonicalize C++ and reject unsupported or unbounded exercises", () => {
	assert.equal(parseCodeExercise({ ...CODE_DEMO_EXERCISE, language: "C++" }).language, "cpp");
	assert.throws(() => parseCodeExercise({ ...CODE_DEMO_EXERCISE, language: "python" }), /C\+\+ only/);
	assert.throws(() => parseCodeExercise({ ...CODE_DEMO_EXERCISE, starterCode: "x".repeat(65_537) }), /64 KiB/);
	assert.throws(() => parseCodeExercise({ ...CODE_DEMO_EXERCISE, tests: [] }), /between 1 and 12/);
	assert.throws(() => parseCodeExercise({ ...CODE_DEMO_EXERCISE, tests: [{ name: "huge", stdin: "x".repeat(8193), expectedStdout: "" }] }), /8 KiB/);
});

test("C++ starter compiles but behavioral tests fail until the learner solves it", local, async () => {
	const unfinished = await check(CODE_DEMO_EXERCISE.starterCode);
	assert.equal(unfinished.status, "tests_failed");
	assert.equal(unfinished.tests.filter((row) => row.status === "failed").length, 3);
	const source = CODE_DEMO_EXERCISE.starterCode.replace("return 0;", "return a + b;");
	const solved = await check(source);
	assert.equal(solved.status, "passed");
	assert.equal(solved.source, source);
	assert.equal(solved.tests.length, 4);
	assert.ok(solved.tests.every((row) => row.status === "passed"));
	assert.match(solved.compiler, /std=c\+\+20/);
});

test("compile errors do not run tests and return real diagnostics", local, async () => {
	const result = await check("int main( { return 0; }");
	assert.equal(result.status, "compilation_error");
	assert.match(result.stderr, /error/i);
	assert.deepEqual(result.tests, []);
});

test("runtime exits and timeouts are distinct from failed answer tests", local, async () => {
	const crash = await check("int main() { return 7; }");
	assert.equal(crash.status, "runtime_error");
	assert.equal(crash.tests[0]?.exitCode, 7);
	const timed = await check("int main() { for (;;) {} }", CODE_DEMO_EXERCISE, { testTimeoutMs: 100 });
	assert.equal(timed.status, "timeout");
	assert.equal(timed.tests.length, 1);
	assert.match(timed.tests[0]!.stderr, /Time limit exceeded/);
});

test("output is bounded and excessive output stops execution", local, async () => {
	const result = await check('#include <iostream>\nint main() { for (;;) std::cout << "too much output\\n"; }');
	assert.equal(result.status, "runtime_error");
	assert.ok(result.tests[0]!.stdout.length <= 65_536);
	assert.match(result.tests[0]!.stderr, /Output limit exceeded/);
});

test("missing compilers report unavailable instead of pretending to compile", async () => {
	const result = await check(CODE_DEMO_EXERCISE.starterCode, CODE_DEMO_EXERCISE, { compilerCandidates: ["/nonexistent/learnharness-cpp-compiler"] });
	assert.equal(result.status, "unavailable");
	assert.match(result.stderr, /compiler was not found/);
	assert.deepEqual(result.tests, []);
});

test("execution environment does not inherit provider credentials or launch capabilities", () => {
	const env = codeProcessEnvironment("/tmp/code-test");
	assert.equal(env.HOME, "/tmp/code-test");
	assert.deepEqual(Object.keys(env).filter((key) => !["NODE_ENV", "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "WINDIR"].includes(key)), []);
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.LH_DESKTOP_API_SECRET, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
});
