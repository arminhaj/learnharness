import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { normalizeCodeActivity, type CodeRunDetail } from "../src/core/code-activity.ts";
import { assessStdio } from "../src/core/code-assessment.ts";
import { codeResultLabels, codeStatusLabel, learnerDiagnostics } from "../src/core/code-result-view.ts";
import { CODE_DEMO_EXERCISE, parseCodeExercise, type CodeRunResult } from "../src/core/code-workspace.ts";
import { runCodeExercise, runCodeProgram } from "../src/server/code-runner.ts";
import { codeProfileReadiness, providerForLanguage, snapshotIdFor } from "../src/server/code-providers.ts";
import { CODE_RUN_RECORD_LIMIT } from "../src/server/code-process.ts";
import { createCodeWorkspaceService } from "../src/server/code-workspaces.ts";

const compilerAvailable = ["clang++", "g++"].some(command => spawnSync(command, ["--version"], { timeout: 5_000 }).status === 0);
const local = { skip: !compilerAvailable };
const roots: string[] = [];
after(() => roots.forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));
const base = { workspaceId: "fixture", revision: "fixture", exercise: CODE_DEMO_EXERCISE };
const solved = CODE_DEMO_EXERCISE.starterCode.replace("return 0;", "return a + b;");

test("stdio assessment is independent of execution and keeps final-newline normalization", () => {
	const check = normalizeCodeActivity(CODE_DEMO_EXERCISE).check;
	const out = (index: number, stdout: string, completed = true) => ({ caseId: check.cases[index]!.id, completed, stdout });
	assert.equal(assessStdio(check, [out(0, "5\r\n\n"), out(1, "-5"), out(2, "0\n"), out(3, "4000000000")]).verdict, "passed");
	assert.equal(assessStdio(check, [out(0, "5\n"), out(1, "-5 \n"), out(2, "0\n"), out(3, "4000000000\n")]).verdict, "failed", "interior/trailing spaces are part of the answer");
	const none = assessStdio(check, []);
	assert.equal(none.verdict, "not_run");
	assert.ok(none.cases.every(item => item.status === "not_run"));
	assert.equal(assessStdio(check, [out(0, "5\n", false)]).cases[0]!.status, "not_run");
});

test("a custom run has no check case and no verdict", local, async () => {
	const run = await runCodeProgram({ ...base, source: solved }, "7 8\n");
	assert.equal(run.status, "completed");
	assert.equal(run.stdout, "15\n");
	const wrong = await runCodeProgram({ ...base, source: "int main() { return 3; }" }, "");
	assert.equal(wrong.status, "runtime_error");
});

test("new runs attach versioned evidence whose snapshot tracks every execution input", local, async () => {
	const result = await runCodeExercise({ ...base, source: solved });
	assert.equal(result.status, "passed");
	const detail = result.detail!;
	assert.equal(detail.version, 1);
	assert.deepEqual(detail.profile, { id: "cpp20-stdio", version: 1 });
	assert.deepEqual(detail.evidence.phases.map(phase => phase.kind), ["build", "execution", "execution", "execution", "execution"]);
	assert.equal(detail.assessment.verdict, "passed");
	const id = (source: string, support: { path: string; source: string }[] = [], exercise = CODE_DEMO_EXERCISE) => snapshotIdFor(normalizeCodeActivity({ ...exercise, starterCode: source }, support));
	assert.equal(detail.evidence.snapshotId, id(solved));
	assert.notEqual(id(solved), id(`${solved}\n`));
	assert.notEqual(id(solved), id(solved, [{ path: "util.hpp", source: "" }]));
	assert.notEqual(id(solved), id(solved, [], { ...CODE_DEMO_EXERCISE, tests: CODE_DEMO_EXERCISE.tests.slice(1) }));
});

test("build failure and failed assessment are reported separately in evidence", local, async () => {
	const broken = await runCodeExercise({ ...base, source: "int main( { return 0; }" });
	assert.equal(broken.status, "compilation_error");
	assert.equal(broken.detail!.assessment.verdict, "not_run");
	assert.equal(broken.detail!.evidence.phases.length, 1);
	assert.ok(broken.detail!.evidence.diagnostics.some(diagnostic => diagnostic.resourceId === "learner" && diagnostic.range?.line === 1));
	assert.equal(codeStatusLabel(broken), "Compilation failed");
	const wrong = await runCodeExercise({ ...base, source: CODE_DEMO_EXERCISE.starterCode });
	assert.equal(wrong.status, "tests_failed");
	assert.equal(wrong.detail!.assessment.verdict, "failed");
	assert.ok(wrong.detail!.evidence.phases.every(phase => phase.status === "passed"), "every process completed; only the assessment failed");
});

test("supporting-file compiler errors are attributed to their own resource, not the learner file", local, async () => {
	const exercise = parseCodeExercise({ ...CODE_DEMO_EXERCISE, starterCode: "int helper();\nint main() { return helper(); }\n" });
	const result = await runCodeExercise({ ...base, exercise, source: exercise.starterCode, supportFiles: [{ path: "helper.cpp", source: "int helper() { return missing; }\n" }] });
	assert.equal(result.status, "compilation_error");
	const errors = result.detail!.evidence.diagnostics.filter(diagnostic => diagnostic.severity === "error");
	assert.ok(errors.length > 0 && errors.every(diagnostic => diagnostic.resourceId === "support:helper.cpp"));
	assert.deepEqual(learnerDiagnostics(result, "solution.cpp"), []);
});

test("missing toolchains and unsupported languages are explicit and never throw", async () => {
	const missing = await runCodeExercise({ ...base, source: solved }, { compilerCandidates: ["/nonexistent/learnharness-cpp"] });
	assert.equal(missing.status, "unavailable");
	assert.equal(missing.detail!.evidence.phases[0]!.status, "unavailable");
	assert.equal(codeStatusLabel(missing), "Compiler unavailable");
	const unsupported = await runCodeExercise({ ...base, source: solved, exercise: { ...CODE_DEMO_EXERCISE, language: "javascript" } });
	assert.equal(unsupported.status, "unavailable");
	assert.match(unsupported.stderr, /No local runner for javascript/);
	assert.equal(providerForLanguage("javascript"), undefined);
	assert.equal(providerForLanguage("rs")?.profileId, "rust2021-stdio");
});

test("readiness is a serializable view, separate from parsing", async () => {
	const readiness = await codeProfileReadiness();
	assert.deepEqual(readiness.map(item => item.profileId), ["cpp20-stdio", "python3-stdio", "rust2021-stdio"]);
	assert.deepEqual(JSON.parse(JSON.stringify(readiness)), readiness);
	assert.equal(readiness[0]!.state === "ready", compilerAvailable);
	assert.ok(readiness[1]!.state === "ready" || /3\.11/.test(readiness[1]!.message ?? ""));
});

test("result labels and diagnostics fall back to C++ for historical results without evidence", () => {
	const historical: CodeRunResult = { id: randomUUID(), workspaceId: "w", source: "", revision: "", language: "cpp", status: "compilation_error", compiler: "clang++", stdout: "", stderr: "solution.cpp:2:5: error: bad\nutil.cpp:9:1: error: other\n", tests: [], createdAt: "" };
	assert.equal(codeResultLabels(historical).buildOutput, "Compiler output");
	assert.equal(codeStatusLabel({ ...historical, status: "tests_failed" }), "Compiled · some tests failed");
	assert.deepEqual(learnerDiagnostics(historical, "solution.cpp").map(item => [item.line, item.column]), [[2, 5]]);
});

test("submission rejects new evidence whose snapshot no longer matches, and accepts matching or historical runs", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-evidence-test-")); roots.push(root);
	const ids = { chatId: "fixture", problemCallId: "problem_1" };
	let snapshotOverride: string | undefined;
	let version: number = 1;
	const service = createCodeWorkspaceService({
		directory: path.join(root, "workspaces"),
		getExercise: () => CODE_DEMO_EXERCISE,
		runner: async input => {
			const spec = normalizeCodeActivity({ ...input.exercise, starterCode: input.source }, input.supportFiles ?? []);
			const detail = { version, profile: { id: "cpp20-stdio", version: 1 }, evidence: { snapshotId: snapshotOverride ?? snapshotIdFor(spec), phases: [], diagnostics: [] }, assessment: { checkKind: "stdio", verdict: "not_run", cases: [] } } as unknown as CodeRunDetail;
			return { id: randomUUID(), workspaceId: input.workspaceId, source: input.source, revision: input.revision, language: "cpp", status: "tests_failed", compiler: "stub", stdout: "", stderr: "", tests: [], createdAt: new Date().toISOString(), detail };
		},
	});
	const good = (await service.execute({ ...ids, action: "check" })).lastRun!;
	assert.equal(service.getRunForSubmission(ids.chatId, ids.problemCallId, good.id).id, good.id);
	snapshotOverride = "0".repeat(64);
	const forged = (await service.execute({ ...ids, action: "check" })).lastRun!;
	assert.throws(() => service.getRunForSubmission(ids.chatId, ids.problemCallId, forged.id), /no longer matches/);
	snapshotOverride = undefined; version = 2;
	const future = (await service.execute({ ...ids, action: "check" })).lastRun!;
	assert.throws(() => service.getRunForSubmission(ids.chatId, ids.problemCallId, future.id), /no longer matches/);
	// A failed check remains readable and viewable even when its evidence is rejected for submission.
	assert.equal((await service.execute({ ...ids, action: "load" })).lastRun!.id, future.id);
});

test("timeouts, cancellation, and excess output are distinct execution phases in evidence", local, async () => {
	const one = { ...CODE_DEMO_EXERCISE, tests: CODE_DEMO_EXERCISE.tests.slice(0, 1) };
	const timed = await runCodeExercise({ ...base, exercise: one, source: "int main() { for (;;) {} }" }, { testTimeoutMs: 100 });
	assert.equal(timed.detail!.evidence.phases[1]!.status, "timeout");
	assert.equal(timed.detail!.assessment.verdict, "not_run");
	const flood = await runCodeExercise({ ...base, exercise: one, source: '#include <iostream>\nint main() { for (;;) std::cout << "x\\n"; }' });
	assert.equal(flood.detail!.evidence.phases[1]!.status, "output_limit");
	assert.equal(flood.status, "runtime_error");
	const controller = new AbortController();
	controller.abort();
	const cancelled = await runCodeExercise({ ...base, exercise: one, source: solved }, { signal: controller.signal });
	assert.ok(["cancelled"].includes(cancelled.detail!.evidence.phases.at(-1)!.status));
	assert.equal(cancelled.status, "timeout", "legacy facade keeps its old status for cancellation");
});

test("materially different build-source selections have different snapshots; default and equivalent explicit match", () => {
	const support = [{ path: "a.cpp", source: "int a() { return 1; }\n" }, { path: "b.cpp", source: "int b() { return 2; }\n" }, { path: "c.hpp", source: "" }];
	const spec = normalizeCodeActivity(CODE_DEMO_EXERCISE, support);
	const id = (sources?: string[]) => snapshotIdFor(spec, sources);
	assert.equal(id(), id(["solution.cpp", "a.cpp", "b.cpp"]), "the default selection is the entry plus supporting .cpp files in order");
	assert.notEqual(id(["solution.cpp", "a.cpp"]), id(["solution.cpp", "b.cpp"]));
	assert.notEqual(id(["solution.cpp", "a.cpp"]), id());
	assert.notEqual(id(["solution.cpp", "b.cpp", "a.cpp"]), id());
	assert.throws(() => id(["solution.cpp", "c.hpp"]), /compilation sources/);
	assert.throws(() => id(["solution.cpp", "missing.cpp"]), /compilation sources/);
});

test("a trusted source override changes the evidence snapshot of an otherwise identical project", local, async () => {
	const exercise = parseCodeExercise({ ...CODE_DEMO_EXERCISE, starterCode: "int main() { return 0; }\n" });
	const support = [{ path: "a.cpp", source: "int a() { return 1; }\n" }, { path: "b.cpp", source: "int b() { return 2; }\n" }];
	const run = (compileSources?: string[]) => runCodeExercise({ ...base, exercise, source: exercise.starterCode, supportFiles: support, ...(compileSources ? { compileSources } : {}) });
	const [a, b, all] = await Promise.all([run(["solution.cpp", "a.cpp"]), run(["solution.cpp", "b.cpp"]), run()]);
	assert.notEqual(a.detail!.evidence.snapshotId, b.detail!.evidence.snapshotId);
	assert.equal(all.detail!.evidence.snapshotId, (await run(["solution.cpp", "a.cpp", "b.cpp"])).detail!.evidence.snapshotId);
});

test("learner diagnostics keep a same-line end column but never fake a multiline span", () => {
	const diagnostic = (range: { line: number; column: number; endLine?: number; endColumn?: number }) => ({ resourceId: "learner", path: "solution.cpp", range, severity: "error" as const, message: "m", source: "compiler" });
	const detail = (diagnostics: ReturnType<typeof diagnostic>[]): CodeRunDetail => ({ version: 1, profile: { id: "cpp20-stdio", version: 1 }, evidence: { snapshotId: "s", phases: [], diagnostics }, assessment: { checkKind: "stdio", verdict: "not_run", cases: [] } });
	const result = (diagnostics: ReturnType<typeof diagnostic>[]): CodeRunResult => ({ id: "i", workspaceId: "w", source: "", revision: "", language: "cpp", status: "compilation_error", compiler: "", stdout: "", stderr: "", tests: [], createdAt: "", detail: detail(diagnostics) });
	const out = learnerDiagnostics(result([
		diagnostic({ line: 3, column: 2, endColumn: 9 }),
		diagnostic({ line: 4, column: 2, endLine: 4, endColumn: 9 }),
		diagnostic({ line: 5, column: 2, endLine: 6, endColumn: 4 }),
	]), "solution.cpp");
	assert.deepEqual(out.map(item => [item.line, item.column, item.endColumn]), [[3, 2, 9], [4, 2, 9], [5, 2, undefined]]);
});

test("a legal maximum-size output case persists, reloads, and resolves for submission", local, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-large-run-test-")); roots.push(root);
	// Twelve cases that each print 60,000 newlines: within every execution limit, and a pass,
	// since only final line endings are ignored and the expected output is empty.
	const exercise = parseCodeExercise({ language: "cpp", starterCode: '#include <cstdio>\nint main() { for (int i = 0; i < 60000; i++) std::putchar(10); }\n', tests: Array.from({ length: 12 }, (_, i) => ({ name: `case ${i}`, stdin: "", expectedStdout: "" })) });
	const service = createCodeWorkspaceService({ directory: path.join(root, "workspaces"), getExercise: () => exercise });
	const ids = { chatId: "fixture", problemCallId: "problem_1" };
	const checked = await service.execute({ ...ids, action: "check" });
	assert.equal(checked.lastRun!.status, "passed");
	assert.equal(checked.lastRun!.tests.length, 12);
	const file = path.join(path.dirname(checked.path), `${checked.lastRun!.id}.json`);
	const size = fs.statSync(file).size;
	assert.ok(size > 2 * 1024 * 1024, `fixture must exceed the former 2 MiB cap (was ${size})`);
	assert.ok(size <= CODE_RUN_RECORD_LIMIT);
	const reloaded = await service.execute({ ...ids, action: "load" });
	assert.equal(reloaded.lastRun!.id, checked.lastRun!.id);
	const saved = await service.execute({ ...ids, action: "save", source: `${exercise.starterCode}// edit\n`, expectedRevision: reloaded.revision });
	assert.equal(saved.lastRun!.id, checked.lastRun!.id, "later saves still load");
	const rechecked = await service.execute({ ...ids, action: "check" });
	assert.equal(service.getRunForSubmission(ids.chatId, ids.problemCallId, rechecked.lastRun!.id).id, rechecked.lastRun!.id);
});

test("an oversized record is refused before lastRunId is published", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-oversize-test-")); roots.push(root);
	const service = createCodeWorkspaceService({
		directory: path.join(root, "workspaces"),
		getExercise: () => CODE_DEMO_EXERCISE,
		runner: async input => ({ id: randomUUID(), workspaceId: input.workspaceId, source: input.source, revision: input.revision, language: "cpp", status: "tests_failed", compiler: "stub", stdout: "x".repeat(CODE_RUN_RECORD_LIMIT), stderr: "", tests: [], createdAt: new Date().toISOString() }),
	});
	const ids = { chatId: "fixture", problemCallId: "problem_1" };
	await assert.rejects(service.execute({ ...ids, action: "check" }), /too large/);
	const view = await service.execute({ ...ids, action: "load" });
	assert.equal(view.lastRun, undefined);
});
