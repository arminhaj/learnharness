import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { normalizeCodeActivity } from "../src/core/code-activity.ts";
import { codeStatusLabel, learnerDiagnostics } from "../src/core/code-result-view.ts";
import { parseCodeExercise, PYTHON_DEMO_EXERCISE, type CodeExercise } from "../src/core/code-workspace.ts";
import { runProcess } from "../src/server/code-process.ts";
import { runCodeExercise, runCodeProgram } from "../src/server/code-runner.ts";
import { discoverPython } from "../src/server/python-provider.ts";
import { snapshotIdFor } from "../src/server/code-providers.ts";

const roots: string[] = [];
after(() => roots.forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));
const scratch = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-python-test-")); roots.push(directory); return directory; };

// Real discovery on this machine: python3 may be too old, so fall through to `python`.
const found = await discoverPython([{ command: "python3", args: [] }, { command: "python", args: [] }], runProcess, os.tmpdir());
const python = found.interpreter;
const local = { skip: python ? false : "no Python 3.11+ interpreter on PATH" };

const base = { workspaceId: "fixture", revision: "fixture" };
const exercise = (source: string, tests: CodeExercise["tests"] = PYTHON_DEMO_EXERCISE.tests): CodeExercise => ({ language: "python", starterCode: source, tests });
const run = (source: string, options: Parameters<typeof runCodeExercise>[1] = {}, extra: { supportFiles?: { path: string; source: string }[]; tests?: CodeExercise["tests"] } = {}) =>
	runCodeExercise({ ...base, exercise: exercise(source, extra.tests), source, ...(extra.supportFiles ? { supportFiles: extra.supportFiles } : {}) }, options);
const solved = PYTHON_DEMO_EXERCISE.starterCode.replace("return 0", "return a + b");
const one = [{ name: "only", stdin: "", expectedStdout: "ok\n" }];

/** A fake interpreter that answers the version probe and nothing else. */
function fakeInterpreter(version: string): string {
	const file = path.join(scratch(), "fake-python");
	fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
	return file;
}

test("catalog-level parsing accepts Python and its aliases without any interpreter", () => {
	for (const language of ["python", "py", "Python3"]) assert.equal(parseCodeExercise({ ...PYTHON_DEMO_EXERCISE, language }).language, "python");
	const spec = normalizeCodeActivity(PYTHON_DEMO_EXERCISE, [{ path: "pkg/util.py", source: "" }]);
	assert.deepEqual(spec.profile, { id: "python3-stdio", version: 1 });
	assert.deepEqual(spec.resources.map(resource => resource.path), ["solution.py", "pkg/util.py"]);
	assert.throws(() => normalizeCodeActivity(PYTHON_DEMO_EXERCISE, [{ path: "a.py", source: "" }, { path: "a.py/b.py", source: "" }]), /conflicts/);
});

test("discovery skips an old python3 and continues to a newer interpreter; old or missing runtimes are explained", async () => {
	const fake = (version: string) => ({ command: fakeInterpreter(version), args: [] });
	const missing = { command: "/nonexistent/learnharness-python", args: [] };
	const chosen = await discoverPython([fake("3.9.6"), missing, fake("3.11.0")], runProcess, os.tmpdir());
	assert.equal(chosen.interpreter?.version, "3.11.0", "3.9.6 is skipped, 3.11.0 is accepted");
	const oldOnly = await discoverPython([missing, fake("3.9.6"), fake("2.7.18")], runProcess, os.tmpdir());
	assert.equal(oldOnly.interpreter, undefined);
	assert.match(oldOnly.message!, /3\.11 or newer is required.*Python 3\.9\.6/);
	const none = await discoverPython([missing], runProcess, os.tmpdir());
	assert.match(none.message!, /3\.11 or newer was not found/);
	const stub = await discoverPython([{ command: "/bin/echo", args: ["not a version"] }], runProcess, os.tmpdir());
	assert.equal(stub.interpreter, undefined, "a launcher stub that prints something else is not a runtime");
	assert.equal((await discoverPython([fake("3.12.1"), fake("3.11.0")], runProcess, os.tmpdir())).interpreter?.version, "3.12.1", "first acceptable candidate wins");
	assert.equal((await discoverPython([fake("4.0.0")], runProcess, os.tmpdir())).interpreter?.version, "4.0.0");
});

test("a missing or old interpreter reports unavailable with evidence and an actionable message", async () => {
	const missing = await run(solved, { compilerCandidates: ["/nonexistent/learnharness-python"] });
	assert.equal(missing.status, "unavailable");
	assert.match(missing.stderr, /Python 3\.11 or newer was not found/);
	assert.equal(missing.detail!.evidence.phases[0]!.kind, "preparation");
	assert.equal(missing.detail!.evidence.phases[0]!.status, "unavailable");
	assert.equal(codeStatusLabel(missing), "Python unavailable");
	const old = await run(solved, { compilerCandidates: [fakeInterpreter("3.9.6")] });
	assert.equal(old.status, "unavailable");
	assert.match(old.stderr, /only Python 3\.9\.6/);
	assert.deepEqual(old.tests, []);
});

test("candidate fallback in a real run: an old first candidate is skipped for the real interpreter", local, async () => {
	const result = await run(solved, { compilerCandidates: [fakeInterpreter("3.9.6"), "/nonexistent/learnharness-python", python!.command] });
	assert.equal(result.status, "passed");
	assert.match(result.compiler, new RegExp(python!.version.replace(/\./g, "\\.")));
});

test("correct output passes; wrong output fails the assessment, not the run", local, async () => {
	const passed = await run(solved);
	assert.equal(passed.status, "passed");
	assert.equal(passed.language, "python");
	assert.equal(passed.tests.length, 4);
	assert.deepEqual(passed.detail!.evidence.phases.map(phase => [phase.kind, phase.status]), [["preparation", "passed"], ["execution", "passed"], ["execution", "passed"], ["execution", "passed"], ["execution", "passed"]]);
	assert.equal(passed.detail!.assessment.verdict, "passed");
	assert.equal(codeStatusLabel({ ...passed, status: "tests_failed" }), "Syntax valid · some tests failed");
	const wrong = await run(PYTHON_DEMO_EXERCISE.starterCode);
	assert.equal(wrong.status, "tests_failed");
	assert.equal(wrong.detail!.assessment.verdict, "failed");
	assert.ok(wrong.detail!.evidence.phases.every(phase => phase.status === "passed"));
	assert.equal(wrong.tests.filter(test => test.status === "failed").length, 3);
});

test("syntax errors stop in preparation with a structured diagnostic and no execution", local, async () => {
	const result = await run("def add(a, b:\n    return a + b\n");
	assert.equal(result.status, "preparation_error");
	assert.deepEqual(result.tests, []);
	assert.equal(result.detail!.assessment.verdict, "not_run");
	assert.deepEqual(result.detail!.evidence.phases.map(phase => phase.kind), ["preparation"]);
	assert.match(result.stderr, /solution\.py:\d+:\d+: SyntaxError/);
	assert.equal(codeStatusLabel(result), "Syntax check failed", "never called compilation");
	const [diagnostic] = result.detail!.evidence.diagnostics;
	assert.equal(diagnostic!.resourceId, "learner");
	assert.equal(diagnostic!.source, "python");
	assert.ok(diagnostic!.range!.line >= 1 && diagnostic!.range!.column! >= 1);
	assert.equal(learnerDiagnostics(result, "solution.py").length, 1);
	assert.equal((await run("if True:\nprint(1)\n")).status, "preparation_error", "IndentationError is a preparation error too");
});

test("a syntax error in a supporting module is attributed to that module, and every .py file is validated", local, async () => {
	const result = await run("import helper\nprint('ok')\n", {}, { tests: one, supportFiles: [{ path: "helper.py", source: "def broken(:\n" }] });
	assert.equal(result.status, "preparation_error");
	const diagnostics = result.detail!.evidence.diagnostics;
	assert.ok(diagnostics.length > 0 && diagnostics.every(item => item.resourceId === "support:helper.py"));
	assert.deepEqual(learnerDiagnostics(result, "solution.py"), [], "support-file failures are never underlined in the learner file");
});

test("runtime exceptions are runtime errors with line-only tracebacks mapped to real resources", local, async () => {
	const source = "import helper\n\ndef main():\n    helper.explode()\n\nmain()\n";
	const failing = await run(source, {}, { tests: one, supportFiles: [{ path: "helper.py", source: "def explode():\n    raise ValueError('boom')\n" }] });
	assert.equal(failing.status, "runtime_error");
	assert.equal(failing.tests[0]!.exitCode, 1);
	assert.match(failing.tests[0]!.stderr, /ValueError: boom/);
	const diagnostics = failing.detail!.evidence.diagnostics;
	const errors = diagnostics.filter(item => item.severity === "error");
	assert.deepEqual(errors.map(item => [item.resourceId, item.range]), [["support:helper.py", { line: 2 }]], "the exception is on the support module that raised it, with no invented column");
	assert.equal(errors[0]!.message, "ValueError: boom");
	assert.ok(diagnostics.some(item => item.resourceId === "learner" && item.severity === "info" && item.range?.line === 4), "the calling frame is informational");
	assert.deepEqual(learnerDiagnostics(failing, "solution.py"), []);
	const own = await run("def f():\n    return 1 / 0\n\nf()\n", {}, { tests: one });
	const mine = learnerDiagnostics(own, "solution.py");
	assert.deepEqual(mine.map(item => [item.line, item.lineOnly, item.severity]), [[2, true, "error"]], "a traceback line without a column is a line diagnostic");
	assert.match(mine[0]!.message, /ZeroDivisionError/);
	assert.ok(!own.detail!.evidence.diagnostics.some(item => item.path.includes("/")), "stdlib and unknown frames are not mapped");
});

test("timeout, cancellation, and excess output are distinct evidence", local, async () => {
	const timed = await run("while True:\n    pass\n", { testTimeoutMs: 300 }, { tests: one });
	assert.equal(timed.status, "timeout");
	assert.equal(timed.detail!.evidence.phases[1]!.status, "timeout");
	const flood = await run("import sys\nwhile True:\n    sys.stdout.write('x' * 1000)\n", {}, { tests: one });
	assert.equal(flood.status, "runtime_error");
	assert.equal(flood.detail!.evidence.phases[1]!.status, "output_limit");
	assert.ok(flood.tests[0]!.stdout.length <= 65_536);
	assert.match(flood.tests[0]!.stderr, /Output limit exceeded/);
	const controller = new AbortController();
	const pending = run("import time\ntime.sleep(30)\n", { signal: controller.signal, testTimeoutMs: 30_000 }, { tests: one });
	setTimeout(() => controller.abort(), 700);
	const cancelled = await pending;
	assert.equal(cancelled.detail!.evidence.phases.at(-1)!.status, "cancelled");
	assert.equal(cancelled.status, "timeout", "legacy facade keeps its status; evidence is distinct");
});

test("standard-library imports, Unicode I/O, and the approved interpreter flags", local, async () => {
	const source = [
		"import collections, json, math, re, sys",
		"text = sys.stdin.read()",
		"print(json.dumps({'n': len(text), 'upper': text.strip().upper(), 'pi': round(math.pi, 2)}, ensure_ascii=False))",
		"print(sys.flags.ignore_environment, sys.flags.no_site, sys.dont_write_bytecode, sys.flags.utf8_mode)",
	].join("\n");
	const stdin = "héllo ✓ 你好 🎉\n";
	const result = await run(source, {}, { tests: [{ name: "unicode", stdin, expectedStdout: `{"n": 13, "upper": "HÉLLO ✓ 你好 🎉", "pi": 3.14}\n1 1 True 1\n` }] });
	assert.equal(result.status, "passed", JSON.stringify(result.tests));
	const printed = await runCodeProgram({ ...base, exercise: exercise("print('ünï ✓')"), source: "print('ünï ✓')" }, "");
	assert.equal(printed.stdout, "ünï ✓\n");
	// Multi-byte characters survive chunk boundaries in large output.
	const wide = await runCodeProgram({ ...base, exercise: exercise("x"), source: "print('你' * 20000)" }, "");
	assert.equal(wide.stdout, `${"你".repeat(20000)}\n`);
});

test("local supporting modules import, including nested packages; no bytecode is written", local, async () => {
	const source = [
		"import os, helper",
		"from pkg import util",
		"from pkg.deep import leaf",
		"print(helper.twice(util.base()), leaf.NAME)",
		"print(sorted(name for name in os.listdir('.') if 'pycache' in name), sorted(os.listdir('pkg')))",
	].join("\n");
	const support = [
		{ path: "helper.py", source: "def twice(x):\n    return x * 2\n" },
		{ path: "pkg/util.py", source: "def base():\n    return 21\n" },
		{ path: "pkg/deep/leaf.py", source: "NAME = 'leaf'\n" },
	];
	const result = await run(source, {}, { supportFiles: support, tests: [{ name: "imports", stdin: "", expectedStdout: "42 leaf\n[] ['deep', 'util.py']\n" }] });
	assert.equal(result.status, "passed", JSON.stringify(result.tests));
	assert.ok(result.detail!.evidence.phases.every(phase => phase.status === "passed"));
});

test("syntax validation never executes learner or support code, even a module shadowing the helper's imports", local, async () => {
	const marker = path.join(scratch(), "executed");
	const shadow = { path: "json.py", source: `open(${JSON.stringify(marker)}, "w").write("ran")\n` };
	const broken = await run("import json\nprint(\n", {}, { tests: one, supportFiles: [shadow] });
	assert.equal(broken.status, "preparation_error");
	assert.equal(fs.existsSync(marker), false, "the trusted helper ran in isolated mode and executed nothing");
	// Control: when the program runs, the module IS imported, so the marker proves the test discriminates.
	const ran = await run("import json\nprint('ok')\n", {}, { tests: one, supportFiles: [shadow] });
	assert.equal(ran.status, "passed");
	assert.equal(fs.existsSync(marker), true);
});

test("custom runs share the pipeline without a verdict, and effective resources drive the snapshot", local, async () => {
	const custom = await runCodeProgram({ ...base, exercise: exercise(solved), source: solved }, "7 8\n");
	assert.deepEqual([custom.status, custom.stdout], ["completed", "15\n"]);
	const syntax = await runCodeProgram({ ...base, exercise: exercise("def(:\n"), source: "def(:\n" }, "");
	assert.equal(syntax.status, "preparation_error");
	assert.match(syntax.compilerStderr, /SyntaxError/);
	const result = await run(solved);
	const id = (src: string, support: { path: string; source: string }[] = []) => snapshotIdFor(normalizeCodeActivity(exercise(src), support));
	assert.equal(result.detail!.evidence.snapshotId, id(solved));
	assert.notEqual(id(solved), id(solved, [{ path: "pkg/a.py", source: "" }]));
	assert.notEqual(id(solved, [{ path: "pkg/a.py", source: "" }]), id(solved, [{ path: "pkg/a.py", source: "x = 1\n" }]));
	assert.throws(() => snapshotIdFor(normalizeCodeActivity(exercise(solved)), ["solution.py"]), /compilation sources/);
	void randomUUID;
});

test("cancellation is preserved through interpreter discovery, not reported as a missing runtime", async () => {
	// Pre-aborted: the real interpreter is present, yet the answer is cancellation, not "install Python".
	const controller = new AbortController();
	controller.abort();
	const before = await run(solved, { signal: controller.signal, compilerCandidates: ["python3", "python"] });
	assert.equal(before.status, "timeout", "legacy facade keeps its cancellation status");
	assert.equal(before.detail!.evidence.phases[0]!.status, "cancelled");
	assert.doesNotMatch(before.stderr, /Install Python|not found/);
	assert.deepEqual(before.tests, []);
	const discovery = await discoverPython([{ command: "python3", args: [] }, { command: "python", args: [] }], runProcess, os.tmpdir(), controller.signal);
	assert.equal(discovery.cancelled, true);
	assert.equal(discovery.interpreter, undefined);
	// Abort while a probe is running: candidate iteration stops, so a later valid interpreter is never reached.
	const slow = path.join(scratch(), "slow-python");
	fs.writeFileSync(slow, "#!/bin/sh\nsleep 5\necho 3.9.0\n", { mode: 0o755 });
	const mid = new AbortController();
	const started = Date.now();
	const pending = runCodeExercise({ ...base, exercise: exercise(solved), source: solved }, { signal: mid.signal, compilerCandidates: [slow, python?.command ?? "python3"] });
	setTimeout(() => mid.abort(), 300);
	const aborted = await pending;
	assert.ok(Date.now() - started < 4000, "the slow probe was cancelled, not awaited");
	assert.equal(aborted.status, "timeout");
	assert.equal(aborted.detail!.evidence.phases[0]!.status, "cancelled");
	assert.deepEqual(aborted.tests, [], "the later real interpreter was never tried");
	const program = await runCodeProgram({ ...base, exercise: exercise(solved), source: solved }, "1 2\n", { signal: controller.signal });
	assert.equal(program.status, "timeout");
});

test("incomplete UTF-8 at end of stream becomes replacement evidence, never an empty pass", local, async () => {
	const emit = (fd: number) => `import os\nos.write(${fd}, bytes([0xe2]))\n`;
	const stdout = await run(emit(1), {}, { tests: [{ name: "empty", stdin: "", expectedStdout: "" }] });
	assert.equal(stdout.tests[0]!.stdout, "\uFFFD");
	assert.equal(stdout.status, "tests_failed", "nonempty output cannot become an empty pass");
	const stderr = await run(emit(2), {}, { tests: [{ name: "empty", stdin: "", expectedStdout: "" }] });
	assert.equal(stderr.tests[0]!.stderr, "\uFFFD");
	assert.equal(stderr.detail!.evidence.phases[1]!.stderr, "\uFFFD", "evidence keeps it too");
	// Valid multi-byte output split across writes still decodes, and a truncated tail after valid text is flagged.
	const split = await run("import os, time\nos.write(1, bytes([0xe4, 0xbd]))\ntime.sleep(0.2)\nos.write(1, bytes([0xa0, 0x0a]))\n", {}, { tests: [{ name: "split", stdin: "", expectedStdout: "你\n" }] });
	assert.equal(split.status, "passed");
	const tail = await run("import os\nos.write(1, 'ok\\n'.encode() + bytes([0xe4, 0xbd]))\n", {}, { tests: [{ name: "tail", stdin: "", expectedStdout: "ok\n" }] });
	assert.equal(tail.tests[0]!.stdout, "ok\n\uFFFD");
	assert.equal(tail.status, "tests_failed");
	// Bounds still hold when the cap lands inside a character.
	const flood = await run("import sys\nwhile True:\n    sys.stdout.write('你' * 5000)\n", {}, { tests: one });
	assert.ok(flood.tests[0]!.stdout.length <= 65_536);
	assert.equal(flood.detail!.evidence.phases[1]!.status, "output_limit");
});

test("runProcess flushes each decoder once and keeps valid split characters", async () => {
	const sh = (script: string) => runProcess("/bin/sh", ["-c", script], os.tmpdir(), "", 5000);
	assert.equal((await sh("printf '\\342'")).stdout, "\uFFFD");
	assert.equal((await sh("printf '\\342' >&2")).stderr, "\uFFFD");
	assert.equal((await sh("printf '\\344\\275'; sleep 0.2; printf '\\240'")).stdout, "你");
	const both = await sh("printf 'a\\342'; printf 'b\\344' >&2");
	assert.deepEqual([both.stdout, both.stderr], ["a\uFFFD", "b\uFFFD"]);
});

test("syntax columns are converted to the editor's UTF-16 columns", local, async () => {
	const columnOf = async (source: string, support?: { path: string; source: string }[]) => {
		const result = await run(source, {}, { tests: one, ...(support ? { supportFiles: support } : {}) });
		assert.equal(result.status, "preparation_error");
		return { result, diagnostic: result.detail!.evidence.diagnostics[0]! };
	};
	// Astral character before the error: Python counts code points, the editor counts UTF-16 units.
	const astral = 'value = "😀"; if True: pass\n';
	const { diagnostic } = await columnOf(astral);
	assert.equal(diagnostic.range!.line, 1);
	assert.ok(astral.slice(diagnostic.range!.column! - 1).startsWith("if"), `column ${diagnostic.range!.column} must start at "if"`);
	assert.ok(diagnostic.range!.endColumn! > diagnostic.range!.column!);
	// Ordinary ASCII is unchanged from Python's own numbers.
	const ascii = "x = (1 +\n";
	const plain = (await columnOf(ascii)).diagnostic.range!;
	assert.deepEqual([plain.line, plain.column], [1, 5]);
	// A multiline range: the end is converted from the END line's text.
	const multi = 'x = [1,\n"😀" 3]\n';
	const range = (await columnOf(multi)).diagnostic.range!;
	const rows = multi.split("\n");
	assert.ok(rows[range.line - 1]!.slice(range.column! - 1).length > 0);
	if (range.endLine !== undefined && range.endLine !== range.line) assert.ok(range.endColumn === undefined || range.endColumn - 1 <= rows[range.endLine - 1]!.length, "end column fits the end line in UTF-16 units");
	assert.ok(range.endColumn === undefined || range.endLine !== undefined || range.endColumn >= range.column!);
	// Untrustworthy mappings degrade to line-only rather than guessing.
	const bom = await columnOf("\uFEFFvalue = (\n");
	assert.equal(bom.diagnostic.range!.column, undefined);
	const cookie = await columnOf("# -*- coding: latin-1 -*-\nvalue = (\n");
	assert.equal(cookie.diagnostic.range!.column, undefined);
	// Support modules convert from their own content, not the learner file's.
	const support = await columnOf("import m\n", [{ path: "m.py", source: 's = "😀"; if True: pass\n' }]);
	assert.equal(support.diagnostic.resourceId, "support:m.py");
	assert.ok('s = "😀"; if True: pass'.slice(support.diagnostic.range!.column! - 1).startsWith("if"));
});
