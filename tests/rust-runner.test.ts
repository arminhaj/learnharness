import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { normalizeCodeActivity } from "../src/core/code-activity.ts";
import { codeStatusLabel, learnerDiagnostics } from "../src/core/code-result-view.ts";
import { parseCodeExercise, RUST_DEMO_EXERCISE, type CodeExercise } from "../src/core/code-workspace.ts";
import { runProcess } from "../src/server/code-process.ts";
import { runCodeExercise, runCodeProgram } from "../src/server/code-runner.ts";
import { snapshotIdFor } from "../src/server/code-providers.ts";
import { discoverRust, rustProvider } from "../src/server/rust-provider.ts";

const roots: string[] = [];
after(() => roots.forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));
const scratch = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rust-test-")); roots.push(directory); return directory; };

// Real discovery on this machine, through the same code the product uses.
const found = await discoverRust(undefined, runProcess);
const rustc = found.compiler;
const local = { skip: rustc ? false : "no Rust 1.56+ compiler found" };

const base = { workspaceId: "fixture", revision: "fixture" };
const exercise = (source: string, tests: CodeExercise["tests"] = RUST_DEMO_EXERCISE.tests): CodeExercise => ({ language: "rust", starterCode: source, tests });
const run = (source: string, options: Parameters<typeof runCodeExercise>[1] = {}, extra: { supportFiles?: { path: string; source: string }[]; tests?: CodeExercise["tests"] } = {}) =>
	runCodeExercise({ ...base, exercise: exercise(source, extra.tests), source, ...(extra.supportFiles ? { supportFiles: extra.supportFiles } : {}) }, options);
const solved = RUST_DEMO_EXERCISE.starterCode.replace("    let _ = (a, b);\n    0\n", "    a + b\n");
const one = [{ name: "only", stdin: "", expectedStdout: "ok\n" }];

function script(body: string): string {
	const file = path.join(scratch(), "tool");
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return file;
}
/** A fake compiler that answers the verbose version probe and, optionally, runs `onCompile` for anything else. */
const fakeRustc = (version: string, onCompile = "exit 1") => script(`if [ "$1" = "--version" ]; then printf 'rustc ${version} (fake)\\nbinary: rustc\\nrelease: ${version}\\nhost: fake-host\\n'; exit 0; fi\n${onCompile}`);

test("catalog-level parsing accepts Rust and its alias without any compiler", () => {
	for (const language of ["rust", "rs", "RS"]) assert.equal(parseCodeExercise({ ...RUST_DEMO_EXERCISE, language }).language, "rust");
	const spec = normalizeCodeActivity(RUST_DEMO_EXERCISE, [{ path: "util/mod.rs", source: "" }, { path: "util/leaf.rs", source: "" }]);
	assert.deepEqual(spec.profile, { id: "rust2021-stdio", version: 1 });
	assert.deepEqual(spec.resources.map(resource => resource.path), ["solution.rs", "util/mod.rs", "util/leaf.rs"]);
	assert.throws(() => normalizeCodeActivity(RUST_DEMO_EXERCISE, [{ path: "a.rs", source: "" }, { path: "a.rs/b.rs", source: "" }]), /conflicts/);
});

test("discovery verifies the actual version: stubs and old compilers are skipped, 1.56 is the floor", async () => {
	const missing = "/nonexistent/learnharness-rustc";
	assert.equal((await discoverRust([missing, fakeRustc("1.56.0")], runProcess)).compiler?.version, "1.56.0");
	assert.equal((await discoverRust([fakeRustc("1.55.1"), missing, fakeRustc("1.57.0")], runProcess)).compiler?.version, "1.57.0", "an old first candidate falls through");
	const old = await discoverRust([missing, fakeRustc("1.55.1"), fakeRustc("1.40.0")], runProcess);
	assert.equal(old.compiler, undefined);
	assert.match(old.message!, /1\.56 or newer is required for the 2021 edition, but only rustc 1\.55\.1 was found/);
	assert.match((await discoverRust([missing], runProcess)).message!, /1\.56 or newer was not found/);
	assert.equal((await discoverRust([script("echo not a compiler")], runProcess)).compiler, undefined, "a stub that prints something else is not a runtime");
	assert.equal((await discoverRust([script("printf 'rustc nonsense\\n'; exit 0")], runProcess)).compiler, undefined);
	assert.equal((await discoverRust(["rustc/../x", "./rustc"], runProcess)).compiler, undefined, "relative candidates are never probed");
});

test("a missing or old compiler reports unavailable with evidence and an actionable message", async () => {
	const missing = await run(solved, { compilerCandidates: ["/nonexistent/learnharness-rustc"] });
	assert.equal(missing.status, "unavailable");
	assert.match(missing.stderr, /Rust 1\.56 or newer was not found.*Nothing is installed or updated for you/);
	assert.deepEqual([missing.detail!.evidence.phases[0]!.kind, missing.detail!.evidence.phases[0]!.status], ["build", "unavailable"]);
	assert.equal(codeStatusLabel(missing), "Rust compiler unavailable");
	const old = await run(solved, { compilerCandidates: [fakeRustc("1.40.0")] });
	assert.equal(old.status, "unavailable");
	assert.match(old.stderr, /only rustc 1\.40\.0/);
	assert.deepEqual(old.tests, []);
	const program = await runCodeProgram({ ...base, exercise: exercise(solved), source: solved }, "1 2\n", { compilerCandidates: ["/nonexistent/learnharness-rustc"] });
	assert.equal(program.status, "unavailable");
});

test("correct output passes; wrong output fails the assessment, not the run", local, async () => {
	const passed = await run(solved);
	assert.equal(passed.status, "passed", JSON.stringify(passed.tests));
	assert.equal(passed.language, "rust");
	assert.match(passed.compiler, /^rustc \d+\.\d+\.\d+ --edition=2021$/);
	assert.deepEqual(passed.detail!.evidence.phases.map(phase => [phase.kind, phase.status]), [["build", "passed"], ["execution", "passed"], ["execution", "passed"], ["execution", "passed"], ["execution", "passed"]]);
	assert.equal(passed.detail!.assessment.verdict, "passed");
	assert.deepEqual(passed.detail!.evidence.toolchain, { id: "rustc", version: rustc!.version });
	assert.equal(codeStatusLabel({ ...passed, status: "tests_failed" }), "Compiled · some tests failed");
	const wrong = await run(RUST_DEMO_EXERCISE.starterCode);
	assert.equal(wrong.status, "tests_failed", "a clean build is not a correct answer");
	assert.equal(wrong.detail!.assessment.verdict, "failed");
	assert.ok(wrong.detail!.evidence.phases.every(phase => phase.status === "passed"));
	assert.equal(wrong.tests.filter(test => test.status === "failed").length, 3);
});

test("type and borrow errors are compilation errors with the compiler's message and a structured position", local, async () => {
	const typed = await run('fn main() {\n    let x: i32 = "a";\n    println!("{}", x);\n}\n', {}, { tests: one });
	assert.equal(typed.status, "compilation_error");
	assert.deepEqual(typed.tests, []);
	assert.equal(typed.detail!.assessment.verdict, "not_run");
	assert.deepEqual(typed.detail!.evidence.phases.map(phase => phase.kind), ["build"]);
	assert.match(typed.stderr, /error\[E0308\]: mismatched types/, "the compiler's own rendering is preserved");
	assert.equal(codeStatusLabel(typed), "Compilation failed");
	const [diagnostic] = typed.detail!.evidence.diagnostics;
	assert.deepEqual([diagnostic!.resourceId, diagnostic!.source, diagnostic!.severity], ["learner", "rustc", "error"]);
	assert.match(diagnostic!.message, /^E0308: mismatched types \(expected `i32`, found `&str`\)/);
	assert.deepEqual(diagnostic!.range, { line: 2, column: 18, endColumn: 21 });
	assert.deepEqual(learnerDiagnostics(typed, "solution.rs").map(item => [item.line, item.column, item.endColumn]), [[2, 18, 21]]);
	const moved = await run('fn take(_s: String) {}\nfn main() {\n    let s = String::from("a");\n    take(s);\n    println!("{}", s);\n}\n', {}, { tests: one });
	assert.equal(moved.status, "compilation_error");
	const borrow = moved.detail!.evidence.diagnostics.find(item => item.severity === "error")!;
	assert.match(borrow.message, /^E0382: borrow of moved value: `s`/);
	assert.equal(borrow.range!.line, 5, "a span inside println! is attributed to the learner's call site");
	assert.ok(moved.detail!.evidence.diagnostics.every(item => item.resourceId === "learner"));
	assert.ok(!moved.detail!.evidence.diagnostics.some(item => /aborting due to/.test(item.message)), "spanless summaries are not attributed to the learner file");
	const warned = await run(solved.replace("fn main() {", "fn main() {\n    let unused = 1;"));
	assert.equal(warned.status, "passed", "warnings do not fail a build");
	assert.deepEqual(warned.detail!.evidence.diagnostics.map(item => [item.severity, item.range!.line]), [["warning", 10]]);
	assert.match(warned.detail!.evidence.phases[0]!.stderr, /unused variable/);
});

test("errors in supporting modules are attributed to their own files; nested and empty modules build and run", local, async () => {
	const support = [
		{ path: "util/mod.rs", source: "pub mod leaf;\npub const BASE: i64 = 40;\n" },
		{ path: "util/leaf.rs", source: "pub fn bonus() -> i64 {\n    2\n}\n" },
		{ path: "empty.rs", source: "" },
		{ path: "deep/inner/more.rs", source: "pub const NAME: &str = \"more\";\n" },
		{ path: "deep/mod.rs", source: "pub mod inner;\n" },
		{ path: "deep/inner/mod.rs", source: "pub mod more;\n" },
	];
	const source = [
		"mod deep;", "mod empty;", "mod util;", "use std::io::Read;", "fn main() {",
		"    let mut text = String::new();", "    std::io::stdin().read_to_string(&mut text).unwrap();",
		"    let n: i64 = text.trim().parse().unwrap();",
		"    println!(\"{} {}\", n + util::BASE + util::leaf::bonus(), deep::inner::more::NAME);", "}", "",
	].join("\n");
	const ok = await run(source, {}, { supportFiles: support, tests: [{ name: "modules", stdin: "0\n", expectedStdout: "42 more\n" }] });
	assert.equal(ok.status, "passed", JSON.stringify(ok.tests) + ok.stderr);
	const broken = await run(source, {}, { supportFiles: support.map(file => file.path === "util/leaf.rs" ? { ...file, source: "pub fn bonus() -> i64 {\n    \"two\"\n}\n" } : file), tests: one });
	assert.equal(broken.status, "compilation_error");
	const errors = broken.detail!.evidence.diagnostics.filter(item => item.severity === "error");
	assert.deepEqual(errors.map(item => [item.resourceId, item.path, item.range!.line]), [["support:util/leaf.rs", "util/leaf.rs", 2]]);
	assert.deepEqual(learnerDiagnostics(broken, "solution.rs"), [], "a support-module error is never underlined in the learner file");
	const missingModule = await run("mod absent;\nfn main() {}\n", {}, { tests: one });
	assert.equal(missingModule.status, "compilation_error");
	assert.match(missingModule.detail!.evidence.diagnostics[0]!.message, /E0583: file not found for module `absent`/);
	assert.equal(missingModule.detail!.evidence.diagnostics[0]!.resourceId, "learner");
	// A module that is never declared with `mod` is not part of the crate, as in ordinary Rust.
	const unreferenced = await run(solved, {}, { supportFiles: [{ path: "dead.rs", source: "this is not rust" }] });
	assert.equal(unreferenced.status, "passed");
});

test("panics and nonzero exits are runtime errors; panics map to workspace lines only", local, async () => {
	const support = [{ path: "util/mod.rs", source: "pub fn boom(v: &[i32]) -> i32 {\n    v[3]\n}\n" }];
	const panics = await run("mod util;\nfn main() {\n    println!(\"{}\", util::boom(&[1]));\n}\n", {}, { tests: one, supportFiles: support });
	assert.equal(panics.status, "runtime_error");
	assert.equal(panics.tests[0]!.exitCode, 101);
	assert.match(panics.tests[0]!.stderr, /panicked at (?:util\/mod\.rs:2:5:|'index out of bounds[^']*', util\/mod\.rs:2:5)/, "either supported message layout");
	const errors = panics.detail!.evidence.diagnostics.filter(item => item.severity === "error");
	assert.deepEqual(errors.map(item => [item.resourceId, item.range, item.source]), [["support:util/mod.rs", { line: 2 }, "rust"]], "line only; a panic column is not trusted");
	assert.match(errors[0]!.message, /^Panic: index out of bounds: the len is 1 but the index is 3/);
	assert.deepEqual(learnerDiagnostics(panics, "solution.rs"), []);
	const own = await run("fn main() {\n    let v: Option<i32> = None;\n    v.unwrap();\n}\n", {}, { tests: one });
	assert.deepEqual(learnerDiagnostics(own, "solution.rs").map(item => [item.line, item.lineOnly, item.severity]), [[3, true, "error"]]);
	assert.match(own.detail!.evidence.diagnostics[0]!.message, /called `Option::unwrap\(\)` on a `None` value/);
	const exits = await run("fn main() {\n    std::process::exit(3);\n}\n", {}, { tests: one });
	assert.equal(exits.status, "runtime_error");
	assert.equal(exits.tests[0]!.exitCode, 3);
	assert.deepEqual(exits.detail!.evidence.diagnostics, []);
	const overflow = await run("fn main() {\n    let x: u8 = std::env::args().count() as u8 + 255;\n    println!(\"{}\", x);\n}\n", {}, { tests: one });
	assert.match(overflow.tests[0]!.stderr, /attempt to add with overflow/, "debug assertions are on, as in a default dev build");
});

test("panic diagnostics read both message layouts and ignore files outside the workspace", () => {
	const spec = normalizeCodeActivity(RUST_DEMO_EXERCISE, [{ path: "m.rs", source: "" }]);
	const map = (stderr: string) => rustProvider.executionDiagnostics!({ directory: "/tmp/ws", spec, stderr }).map(item => [item.path, item.range?.line, item.message]);
	assert.deepEqual(map("thread 'main' (7) panicked at m.rs:4:9:\nexplicit panic\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n"), [["m.rs", 4, "Panic: explicit panic"]]);
	assert.deepEqual(map("thread 'main' panicked at 'old style', solution.rs:2:5\n"), [["solution.rs", 2, "Panic: old style"]]);
	assert.deepEqual(map("thread 'main' (1) panicked at /rustc/abc/library/core/src/option.rs:1:1:\nx\n"), [], "standard-library locations are not workspace files");
	assert.deepEqual(map("thread 'main' (1) panicked at ../secret.rs:1:1:\nx\nthread 'main' (1) panicked at /tmp/ws/solution.rs:9:1:\ny\n"), [["solution.rs", 9, "Panic: y"]], "only a path inside the workspace directory is mapped");
	assert.deepEqual(map("no panic here"), []);
});

test("timeout, cancellation, and excess output are distinct evidence", local, async () => {
	const timed = await run("fn main() {\n    loop {}\n}\n", { testTimeoutMs: 300 }, { tests: one });
	assert.equal(timed.status, "timeout");
	assert.equal(timed.detail!.evidence.phases[1]!.status, "timeout");
	const flood = await run('use std::io::Write;\nfn main() {\n    let out = std::io::stdout();\n    loop {\n        if out.lock().write_all(&[b\'x\'; 1000]).is_err() { break; }\n    }\n}\n', {}, { tests: one });
	assert.equal(flood.status, "runtime_error");
	assert.equal(flood.detail!.evidence.phases[1]!.status, "output_limit");
	assert.ok(flood.tests[0]!.stdout.length <= 65_536);
	assert.match(flood.tests[0]!.stderr, /Output limit exceeded/);
	// Handshake: the program itself reports that it started, so the abort can only land during execution.
	const started = path.join(scratch(), "started");
	const controller = new AbortController();
	const pending = run(`fn main() {\n    std::fs::write(${JSON.stringify(started)}, "x").unwrap();\n    std::thread::sleep(std::time::Duration::from_secs(30));\n}\n`, { signal: controller.signal, testTimeoutMs: 30_000 }, { tests: one });
	for (let waited = 0; !fs.existsSync(started); waited += 20) {
		assert.ok(waited < 60_000, "the program never started");
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	controller.abort();
	const cancelled = await pending;
	assert.deepEqual(cancelled.detail!.evidence.phases.map(phase => [phase.kind, phase.status]), [["build", "passed"], ["execution", "cancelled"]], "the build finished; the execution itself was cancelled");
	assert.equal(cancelled.status, "timeout", "legacy facade keeps its status; evidence is distinct");
});

test("compiler output is bounded: an error flood keeps the cap, the notice, and at most 50 diagnostics", local, async () => {
	const lines = Array.from({ length: 400 }, (_, index) => `    let _v${index} = undefined_name_${index};`);
	const result = await run(`fn main() {\n${lines.join("\n")}\n}\n`, {}, { tests: one });
	assert.equal(result.status, "compilation_error");
	assert.ok(result.stderr.length < 70_000);
	assert.match(result.stderr, /Output limit exceeded/);
	assert.ok(result.detail!.evidence.diagnostics.length > 0 && result.detail!.evidence.diagnostics.length <= 50);
	assert.ok(!/^\{/m.test(result.stderr), "a JSON line cut short by the cap is not shown as compiler text");
});

test("a compile timeout and a cancelled compile are not unavailable", async () => {
	const slow = fakeRustc("1.80.0", "sleep 30");
	const timed = await run(solved, { compilerCandidates: [slow], compileTimeoutMs: 400 });
	assert.equal(timed.status, "timeout");
	assert.equal(timed.detail!.evidence.phases[0]!.status, "timeout");
	const controller = new AbortController();
	const pending = run(solved, { compilerCandidates: [slow], signal: controller.signal });
	setTimeout(() => controller.abort(), 500);
	const cancelled = await pending;
	assert.equal(cancelled.detail!.evidence.phases[0]!.status, "cancelled");
	assert.deepEqual(cancelled.tests, []);
	assert.match(cancelled.compiler, /^rustc 1\.80\.0/);
});

test("Unicode standard I/O round-trips, including characters split across output chunks", local, async () => {
	const source = "use std::io::Read;\nfn main() {\n    let mut text = String::new();\n    std::io::stdin().read_to_string(&mut text).unwrap();\n    println!(\"{} {}\", text.trim().to_uppercase(), text.trim().chars().count());\n    println!(\"{}\", \"你\".repeat(20000));\n}\n";
	const stdin = "héllo ✓ 你好 🎉\n";
	const result = await run(source, {}, { tests: [{ name: "unicode", stdin, expectedStdout: `HÉLLO ✓ 你好 🎉 12\n${"你".repeat(20000)}\n` }] });
	assert.equal(result.status, "passed", JSON.stringify(result.tests.map(test => test.stdout.length)));
	const printed = await runCodeProgram({ ...base, exercise: exercise("x"), source: "fn main() {\n    println!(\"ünï ✓\");\n}\n" }, "");
	assert.deepEqual([printed.status, printed.stdout], ["completed", "ünï ✓\n"]);
});

test("diagnostic columns are converted from Unicode scalars to the editor's UTF-16 columns", local, async () => {
	const columnOf = async (source: string, supportFiles?: { path: string; source: string }[]) => {
		const result = await run(source, {}, { tests: one, ...(supportFiles ? { supportFiles } : {}) });
		assert.equal(result.status, "compilation_error", result.stderr);
		return result.detail!.evidence.diagnostics.find(item => item.severity === "error")!;
	};
	// rustc counts the astral character once; the editor counts two UTF-16 units.
	const astral = 'fn main() {\n    let s = "é😀"; let x: i32 = "a";\n}\n';
	const { range } = await columnOf(astral);
	const line = astral.split("\n")[1]!;
	assert.equal(range!.line, 2);
	assert.equal(line.slice(range!.column! - 1, range!.endColumn! - 1), '"a"', "the span covers exactly the string literal in UTF-16 units");
	assert.ok(range!.column! > Array.from(line).findIndex(char => char === "x") + 1, "the column is past the scalar index of the same token");
	// ASCII is unchanged; CRLF files keep rustc's line numbers.
	assert.deepEqual((await columnOf('fn main() {\r\n    let x: i32 = "a";\r\n}\r\n')).range, { line: 2, column: 18, endColumn: 21 });
	// A multi-line span converts its end from the end line's text.
	const multi = 'fn main() {\n    let x: i32 = {\n        "😀"\n    };\n}\n';
	const spanning = (await columnOf(multi)).range!;
	assert.ok(spanning.line >= 2);
	if (spanning.endColumn !== undefined) assert.ok(spanning.endColumn - 1 <= multi.split("\n")[(spanning.endLine ?? spanning.line) - 1]!.length);
	// Untrustworthy mappings degrade rather than guess.
	assert.deepEqual((await columnOf('﻿fn main() { let x: i32 = "a"; }\n')).range, { line: 1 }, "a BOM on line 1 makes the column unreliable");
	assert.equal((await columnOf('fn main() {\r    let x: i32 = "a";\r}\n')).range, undefined, "a lone CR is a line break only for the editor, so no position is claimed");
	// Support modules convert from their own content.
	const support = await columnOf("mod m;\nfn main() { m::f(); }\n", [{ path: "m.rs", source: 'pub fn f() { let _s = "😀"; let _x: i32 = "a"; }\n' }]);
	assert.equal(support.resourceId, "support:m.rs");
	assert.equal('pub fn f() { let _s = "😀"; let _x: i32 = "a"; }'.slice(support.range!.column! - 1, support.range!.endColumn! - 1), '"a"');
});

test("the compile uses fixed argv and the sanitized environment; Cargo, rustup and the network are never touched", local, async () => {
	const dir = scratch();
	const log = path.join(dir, "log");
	const marks = path.join(dir, "marks");
	fs.mkdirSync(marks);
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	for (const name of ["cargo", "rustup", "curl", "rustc"]) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ntouch ${marks}/${name}\nexit 1\n`, { mode: 0o755 });
	const wrapper = script(`{ echo "ARGV:$*"; echo "PWD:$(pwd)"; env; echo END; } >> ${JSON.stringify(log)}\nexec ${JSON.stringify(rustc!.command)} "$@"`);
	const savedPath = process.env.PATH;
	process.env.PATH = `${bin}:${savedPath}`;
	process.env.OPENAI_API_KEY = "rust-test-secret";
	process.env.CARGO_HOME = "/should/not/leak";
	process.env.RUSTUP_HOME = "/should/not/leak";
	let result;
	try { result = await run(solved, { compilerCandidates: [wrapper] }); }
	finally { process.env.PATH = savedPath; delete process.env.OPENAI_API_KEY; delete process.env.CARGO_HOME; delete process.env.RUSTUP_HOME; }
	assert.equal(result.status, "passed");
	assert.deepEqual(fs.readdirSync(marks), [], "no Cargo, rustup, network client or PATH shim was invoked");
	const blocks = fs.readFileSync(log, "utf8").split("END\n").filter(Boolean);
	assert.equal(blocks.length, 2, "one verbose version probe and one compile");
	const compile = blocks.find(block => block.startsWith("ARGV:--edition"))!;
	const workspace = /^HOME=(.*)$/m.exec(compile)![1]!;
	assert.match(compile, new RegExp(`^ARGV:--edition=2021 --crate-name solution --crate-type bin --error-format=json -o ${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.learnharness-solution solution\\.rs$`, "m"));
	for (const block of blocks) {
		assert.match(block, /^HOME=.*lh-rust-test-|^HOME=.*learnharness-/m);
		assert.doesNotMatch(block, /rust-test-secret|should\/not\/leak|^RUSTUP|^CARGO/m, "credentials and toolchain variables are stripped from the compiler's environment");
		assert.ok(!block.includes(`HOME=${os.homedir()}\n`), "the real home is not exposed to the compiler");
	}
	assert.ok(compile.includes(`HOME=${workspace}\n`), "the build runs with the temporary workspace as HOME");
	assert.ok(!blocks[0]!.includes(workspace), "discovery probed in its own empty directory, not the workspace");
});

/** A fake rustup layout: `bin/rustc` is a link to `bin/rustup`, which resolves to a fake toolchain compiler. */
function fakeProxy(options: { which?: string; exit?: number; hardlink?: boolean } = {}) {
	const dir = scratch();
	const log = path.join(dir, "rustup.log");
	const toolchain = path.join(dir, "toolchain");
	fs.mkdirSync(toolchain);
	const compiler = path.join(toolchain, "rustc");
	fs.writeFileSync(compiler, `#!/bin/sh\nprintf 'rustc 1.90.0 (fake)\\nbinary: rustc\\nrelease: 1.90.0\\nhost: fake-host\\n'\n`, { mode: 0o755 });
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "rustup"), `#!/bin/sh
case "$(basename "$0")" in rustc) echo "proxy-ran" >> ${JSON.stringify(log)}; exit 1;; esac
{ echo "ARGV:$*"; echo "PWD:$(pwd)"; echo "LS:$(ls -A)"; env; echo END; } >> ${JSON.stringify(log)}
if [ "$1 $2" = "which rustc" ]; then ${options.exit ? `exit ${options.exit}` : `echo ${JSON.stringify(options.which ?? compiler)}; exit 0`}; fi
exit 2
`, { mode: 0o755 });
	if (options.hardlink) fs.linkSync(path.join(bin, "rustup"), path.join(bin, "rustc"));
	else fs.symlinkSync("rustup", path.join(bin, "rustc"));
	return { proxy: path.join(bin, "rustc"), compiler, log };
}

test("a rustup proxy is resolved through trusted metadata, never run in the workspace or with learner files", async () => {
	const fake = fakeProxy();
	process.env.OPENAI_API_KEY = "rust-test-secret";
	let discovery;
	try { discovery = await discoverRust([fake.proxy], runProcess); } finally { delete process.env.OPENAI_API_KEY; }
	assert.equal(discovery.compiler?.command, fake.compiler, "the proxy resolves to the toolchain's actual compiler");
	assert.equal(discovery.compiler?.version, "1.90.0");
	const log = fs.readFileSync(fake.log, "utf8");
	assert.doesNotMatch(log, /proxy-ran/, "the shim itself was never executed");
	assert.match(log, /^ARGV:which rustc$/m);
	assert.match(log, /^LS:$/m, "queried from an empty private directory");
	assert.doesNotMatch(log, /^PWD:.*learnharness-code-/m);
	assert.match(log, /^RUSTUP_AUTO_INSTALL=0$/m, "automatic installation is disabled");
	assert.match(log, /^RUSTUP_DIST_SERVER=http:\/\/127\.0\.0\.1:9$/m, "and the download server is unreachable");
	assert.match(log, new RegExp(`^HOME=${os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), "only the metadata query sees the real home");
	assert.doesNotMatch(log, /rust-test-secret|^OPENAI|^ANTHROPIC|TOKEN|SECRET/im, "no credentials reach even the trusted query");
});

test("an unresolvable proxy is explained truthfully, a proxy resolving to another proxy is refused, and cancellation stays cancelled", async () => {
	const none = fakeProxy({ exit: 1 });
	const unresolved = await discoverRust([none.proxy], runProcess);
	assert.equal(unresolved.compiler, undefined);
	assert.match(unresolved.message!, /rustup shim, but rustup could not resolve an installed toolchain.*Nothing is installed or updated for you/);
	const result = await run(solved, { compilerCandidates: [none.proxy] });
	assert.equal(result.status, "unavailable");
	assert.match(result.stderr, /rustup shim/);
	const loop = fakeProxy();
	const again = fakeProxy({ which: loop.proxy });
	assert.equal((await discoverRust([again.proxy], runProcess)).compiler, undefined, "`which` answering with a proxy is not a compiler");
	assert.equal((await discoverRust([path.join(path.dirname(none.proxy), "nope")], runProcess)).compiler, undefined);
	// Cancellation during discovery: a slow rustup query is cancelled, and later candidates are never reached.
	const slow = fakeProxy();
	fs.writeFileSync(path.join(path.dirname(slow.proxy), "rustup"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
	const controller = new AbortController();
	const started = Date.now();
	const pending = run(solved, { compilerCandidates: [slow.proxy, rustc?.command ?? "rustc"], signal: controller.signal });
	setTimeout(() => controller.abort(), 300);
	const cancelled = await pending;
	assert.ok(Date.now() - started < 4000, "the slow query was cancelled, not awaited");
	assert.equal(cancelled.status, "timeout", "legacy facade keeps its cancellation status");
	assert.equal(cancelled.detail!.evidence.phases[0]!.status, "cancelled");
	assert.doesNotMatch(cancelled.stderr, /not found|Install|rustup shim/);
	assert.deepEqual(cancelled.tests, []);
	const before = new AbortController();
	before.abort();
	assert.equal((await discoverRust(undefined, runProcess, before.signal)).cancelled, true);
	const program = await runCodeProgram({ ...base, exercise: exercise(solved), source: solved }, "1 2\n", { signal: before.signal });
	assert.equal(program.status, "timeout");
});

function realProxy(): string | undefined {
	const directories = [...(process.env.PATH ?? "").split(path.delimiter), path.join(process.env.CARGO_HOME || path.join(os.homedir(), ".cargo"), "bin")];
	for (const directory of directories.filter(item => path.isAbsolute(item))) {
		const candidate = path.join(directory, "rustc");
		try { if (path.basename(fs.realpathSync(candidate)) === "rustup") return candidate; } catch { /* Not present here. */ }
	}
	return undefined;
}
const proxy = realProxy();

test("the installed rustup proxy builds and runs under the sanitized HOME", { skip: proxy ? false : "no rustup proxy installed" }, async t => {
	// The premise: spawned naively under the runner's sanitized environment, the proxy cannot find a toolchain.
	const naive = await runProcess(proxy!, ["--version"], scratch(), "", 15_000);
	assert.notEqual(naive.exitCode, 0, "a sanitized HOME hides the rustup default");
	const discovery = await discoverRust([proxy!], runProcess);
	// A rustup install with no usable compiler (no toolchain, or one older than 1.56) is a supported
	// "unavailable" state, not a failure; fixtures cover both messages deterministically.
	if (!discovery.compiler) {
		assert.match(discovery.message!, /rustup could not resolve an installed toolchain|1\.56 or newer is required.*but only rustc \d/);
		return t.skip(/required/.test(discovery.message!) ? "rustup resolves to a compiler older than 1.56 here" : "rustup has no installed toolchain here");
	}
	assert.notEqual(path.basename(fs.realpathSync(discovery.compiler.command)), "rustup", "the real compiler, not the shim");
	const result = await run(solved, { compilerCandidates: [proxy!] });
	assert.equal(result.status, "passed", result.stderr);
	const bare = await run(solved);
	assert.equal(bare.status, "passed", "default discovery finds the same installed compiler");
});

test("custom runs share the pipeline without a verdict, and effective resources drive the snapshot", local, async () => {
	const custom = await runCodeProgram({ ...base, exercise: exercise(solved), source: solved }, "7 8\n");
	assert.deepEqual([custom.status, custom.stdout], ["completed", "15\n"]);
	const broken = await runCodeProgram({ ...base, exercise: exercise("fn main( {"), source: "fn main( {" }, "");
	assert.equal(broken.status, "compilation_error");
	assert.match(broken.compilerStderr, /error/);
	const result = await run(solved);
	const id = (src: string, support: { path: string; source: string }[] = []) => snapshotIdFor(normalizeCodeActivity(exercise(src), support));
	assert.equal(result.detail!.evidence.snapshotId, id(solved));
	assert.notEqual(id(solved), id(solved, [{ path: "util/mod.rs", source: "" }]));
	assert.notEqual(id(solved, [{ path: "m.rs", source: "" }]), id(solved, [{ path: "m.rs", source: "// x\n" }]));
	assert.throws(() => snapshotIdFor(normalizeCodeActivity(exercise(solved)), ["solution.rs"]), /compilation sources/);
});

test("a hardlinked rustup proxy is recognized by inode, never run directly, and resolved through the guarded query", async () => {
	const fake = fakeProxy({ hardlink: true });
	const bin = path.dirname(fake.proxy);
	assert.equal(fs.statSync(fake.proxy).ino, fs.statSync(path.join(bin, "rustup")).ino, "fixture: a real hardlink, not a symlink");
	assert.equal(fs.lstatSync(fake.proxy).isSymbolicLink(), false);
	assert.equal(path.basename(fs.realpathSync(fake.proxy)), "rustc", "realpath cannot reveal it");
	process.env.OPENAI_API_KEY = "rust-test-secret";
	let discovery;
	try { discovery = await discoverRust([fake.proxy], runProcess); } finally { delete process.env.OPENAI_API_KEY; }
	assert.equal(discovery.compiler?.command, fake.compiler);
	const log = fs.readFileSync(fake.log, "utf8");
	assert.doesNotMatch(log, /proxy-ran/, "the hardlinked shim was never executed as rustc");
	assert.match(log, /^ARGV:which rustc$/m);
	assert.match(log, /^RUSTUP_AUTO_INSTALL=0$/m);
	assert.doesNotMatch(log, /rust-test-secret|^OPENAI/m);
	// A hardlink to something other than rustup is an ordinary compiler.
	const plain = fakeProxy();
	const copy = path.join(path.dirname(plain.proxy), "rustc-copy");
	fs.linkSync(plain.compiler, copy);
	assert.equal((await discoverRust([copy], runProcess)).compiler?.command, copy);
});

test("a hardlinked proxy builds with the sanitized environment for every compiler invocation", local, async () => {
	const dir = scratch();
	const log = path.join(dir, "compiler.log");
	const wrapper = script(`{ echo "ARGV:$*"; env; echo END; } >> ${JSON.stringify(log)}\nexec ${JSON.stringify(rustc!.command)} "$@"`);
	const fake = fakeProxy({ hardlink: true, which: wrapper });
	process.env.OPENAI_API_KEY = "rust-test-secret";
	process.env.RUSTUP_HOME = "/should/not/leak";
	let result;
	try { result = await run(solved, { compilerCandidates: [fake.proxy] }); }
	finally { delete process.env.OPENAI_API_KEY; delete process.env.RUSTUP_HOME; }
	assert.equal(result.status, "passed", result.stderr);
	assert.doesNotMatch(fs.readFileSync(fake.log, "utf8"), /proxy-ran/);
	const blocks = fs.readFileSync(log, "utf8").split("END\n").filter(Boolean);
	assert.equal(blocks.length, 2, "version probe and compile");
	for (const block of blocks) {
		assert.doesNotMatch(block, /rust-test-secret|should\/not\/leak|^RUSTUP|^CARGO/m);
		assert.ok(!block.includes(`HOME=${os.homedir()}\n`), "the real home never reaches the compiler");
	}
});

/** A context whose injected runner answers the version probe and returns `compile` for the build. */
function injectedBuild(compile: Partial<Awaited<ReturnType<typeof runProcess>>>) {
	const spec = normalizeCodeActivity(exercise(solved));
	const result = { stdout: "", stderr: "", exitCode: 0, timedOut: false, cancelled: false, outputLimited: false, unavailable: false };
	return rustProvider.build({
		spec, directory: scratch(), timeoutMs: 1000, toolchainCandidates: [fakeRustc("1.80.0")],
		run: async (_command, args) => args[0] === "--version" ? { ...result, stdout: "rustc 1.80.0 (fake)\nrelease: 1.80.0\nhost: h\n" } : { ...result, ...compile },
	});
}

test("the output cap is decided before the exit code and never yields a program", async () => {
	for (const exitCode of [0, 1, null]) {
		const built = await injectedBuild({ outputLimited: true, exitCode });
		assert.equal(built.phase.status, "output_limit", `exit ${exitCode}`);
		assert.equal(built.program, undefined, "a capped build is never run");
	}
	const capped = await injectedBuild({ outputLimited: true, exitCode: 0, stderr: "x\nOutput limit exceeded; process stopped." });
	assert.match(capped.phase.stderr, /Output limit exceeded/);
	assert.equal((await injectedBuild({ outputLimited: false, exitCode: 0 })).phase.status, "passed", "control");
	assert.ok((await injectedBuild({ outputLimited: false, exitCode: 0 })).program);
	assert.equal((await injectedBuild({ timedOut: true, outputLimited: true, exitCode: null })).phase.status, "timeout", "a time limit keeps its own status");
	assert.equal((await injectedBuild({ cancelled: true, timedOut: true, outputLimited: true, exitCode: null })).phase.status, "cancelled");
});

test("cancellation wins before any discovery, even with no candidates", async () => {
	const aborted = new AbortController();
	aborted.abort();
	for (const candidates of [[], ["/nonexistent/learnharness-rustc"], undefined]) {
		assert.deepEqual(await discoverRust(candidates, runProcess, aborted.signal), { cancelled: true });
	}
	assert.equal((await discoverRust([], runProcess)).compiler, undefined, "control: without the signal, no candidates is simply unavailable");
	const result = await run(solved, { compilerCandidates: [], signal: aborted.signal });
	assert.equal(result.detail!.evidence.phases[0]!.status, "cancelled");
	assert.doesNotMatch(result.stderr, /not found|Install/);
	assert.deepEqual(result.tests, []);
});
