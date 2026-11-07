import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { PYTHON_DEMO_EXERCISE, type CodeExercise } from "../src/core/code-workspace.ts";
import { createCodeWorkspaceService } from "../src/server/code-workspaces.ts";
import { codingInstructions } from "../src/server/coding-generation.ts";
import { codingLanguages, parseCodingDraft, parseCodingGoal } from "../src/server/coding-sessions.ts";
import { discoverPython } from "../src/server/python-provider.ts";
import { runProcess } from "../src/server/code-process.ts";

const roots: string[] = [];
after(() => roots.forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));
const scratch = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-python-ws-")); roots.push(directory); return directory; };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const found = await discoverPython([{ command: "python3", args: [] }, { command: "python", args: [] }], runProcess, os.tmpdir());
const local = { skip: found.interpreter ? false : "no Python 3.11+ interpreter on PATH" };

const support = [
	{ path: "pkg/util.py", source: "def base():\n    return 40\n" },
	{ path: "pkg/deep/leaf.py", source: "BONUS = 2\n" },
];
const exercise: CodeExercise = {
	language: "python",
	starterCode: "from pkg import util\nfrom pkg.deep import leaf\na, b = map(int, input().split())\nprint(a + b + util.base() * 0 + leaf.BONUS * 0)\n",
	tests: [{ name: "sum", stdin: "2 3\n", expectedStdout: "5\n" }],
};
const ids = { chatId: "fixture", problemCallId: "problem_1" };
/** Legacy workspace identity: the unversioned exercise projection plus support files. */
const workspaceId = (value: CodeExercise, files = support) => sha(`${ids.chatId}\0${ids.problemCallId}\0${sha(JSON.stringify(files.length ? { exercise: value, supportFiles: files } : value))}`);
const service = (root: string, files = support) => createCodeWorkspaceService({ directory: path.join(root, "workspaces"), getExercise: () => ({ ...exercise, supportFiles: files }) });

test("a Python workspace creates nested support modules privately, with no C++ scaffolding", () => {
	const root = scratch();
	return service(root).execute({ ...ids, action: "load" }).then(view => {
		const directory = path.dirname(view.path);
		assert.equal(view.filename, "solution.py");
		assert.equal(path.basename(directory), workspaceId(exercise), "legacy identity projection, unchanged");
		assert.equal(fs.readFileSync(path.join(directory, "pkg/deep/leaf.py"), "utf8"), "BONUS = 2\n");
		assert.equal(fs.statSync(path.join(directory, "pkg")).mode & 0o777, 0o700);
		assert.deepEqual(fs.readdirSync(directory).sort(), ["pkg", "solution.py", "workspace.json"], "no compile_flags.txt for Python");
	});
});

test("nested support modules run, persist their check, and resolve for submission", local, async () => {
	const svc = service(scratch());
	const checked = await svc.execute({ ...ids, action: "check" });
	assert.equal(checked.lastRun!.status, "passed", JSON.stringify(checked.lastRun!.tests));
	assert.equal(checked.lastRun!.detail!.profile.id, "python3-stdio");
	assert.deepEqual(svc.getRunForSubmission(ids.chatId, ids.problemCallId, checked.lastRun!.id), checked.lastRun);
	const edited = await svc.execute({ ...ids, action: "save", source: `${exercise.starterCode}# edit\n`, expectedRevision: checked.revision });
	assert.throws(() => svc.getRunForSubmission(ids.chatId, ids.problemCallId, checked.lastRun!.id), /changed since this check/);
	const again = await svc.execute({ ...ids, action: "check", expectedRevision: edited.revision });
	assert.equal(svc.getRunForSubmission(ids.chatId, ids.problemCallId, again.lastRun!.id).id, again.lastRun!.id, "new evidence snapshot resolves over the same effective resources");
});

test("an intermediate symlink is refused at creation and nothing is written through it", async () => {
	const root = scratch();
	const outside = scratch();
	const directory = path.join(root, "workspaces", workspaceId(exercise));
	fs.mkdirSync(directory, { recursive: true });
	fs.symlinkSync(outside, path.join(directory, "pkg"));
	await assert.rejects(service(root).execute({ ...ids, action: "load" }), /link or file/);
	assert.deepEqual(fs.readdirSync(outside), [], "support files were not written through the symlink");
	assert.equal(fs.existsSync(path.join(directory, "workspace.json")), false);
});

test("an intermediate symlink swapped in after creation blocks load, check, and submission", local, async () => {
	const root = scratch();
	const svc = service(root);
	const checked = await svc.execute({ ...ids, action: "check" });
	const directory = path.dirname(checked.path);
	// Replace a real directory with a symlink to an identical copy outside the workspace.
	const outside = scratch();
	fs.cpSync(path.join(directory, "pkg"), path.join(outside, "pkg"), { recursive: true });
	fs.rmSync(path.join(directory, "pkg"), { recursive: true });
	fs.symlinkSync(path.join(outside, "pkg"), path.join(directory, "pkg"));
	for (const action of ["load", "check"] as const) await assert.rejects(svc.execute({ ...ids, action }), /link or file/);
	assert.throws(() => svc.getRunForSubmission(ids.chatId, ids.problemCallId, checked.lastRun!.id), /link or file/);
	// A symlinked nested directory deeper in the path is refused as well.
	fs.rmSync(path.join(directory, "pkg"));
	fs.mkdirSync(path.join(directory, "pkg"));
	fs.writeFileSync(path.join(directory, "pkg/util.py"), support[0]!.source);
	fs.symlinkSync(path.join(outside, "pkg/deep"), path.join(directory, "pkg/deep"));
	await assert.rejects(svc.execute({ ...ids, action: "load" }), /link or file/);
});

test("supporting-file contents are still enforced on nested paths", async () => {
	const svc = service(scratch());
	const view = await svc.execute({ ...ids, action: "load" });
	fs.writeFileSync(path.join(path.dirname(view.path), "pkg/util.py"), "def base():\n    return 0\n");
	await assert.rejects(svc.execute({ ...ids, action: "load" }), /Restore the supplied contents of pkg\/util\.py/);
});

const draft = (supportFiles: unknown[], extra: Record<string, unknown> = {}) => ({
	title: "T", brief: "B", hint: "H", reference: "R", supportFiles, simulation: false,
	exercise: { starterCode: "print(1)\n", tests: [{ name: "t", stdin: "", expectedStdout: "1\n" }], ...extra },
});
const projectGoal = { mode: "project" as const, language: "python" as const };

test("generated Python projects accept clean relative .py modules and keep the existing path controls", () => {
	const parsed = parseCodingDraft(draft([{ path: "pkg/util.py", source: "X = 1\n" }, { path: "helpers.py", source: "Y = 2\n" }]), projectGoal);
	assert.equal(parsed.exercise.language, "python");
	assert.deepEqual(parsed.supportFiles.map(file => file.path), ["pkg/util.py", "helpers.py"]);
	for (const bad of ["../x.py", "/abs.py", "a//b.py", "./a.py", "a/./b.py", "pkg\\x.py", ".hidden.py", "pkg/.x.py", "notes.txt", "x.cpp", "solution.py", "SOLUTION.PY", `${"d/".repeat(40)}x.py`]) {
		assert.throws(() => parseCodingDraft(draft([{ path: bad, source: "x = 1\n" }]), projectGoal), /./, bad);
	}
	assert.throws(() => parseCodingDraft(draft([{ path: "a/b.py", source: "x = 1\n" }, { path: "A/B.py", source: "x = 1\n" }]), projectGoal), /unique/);
	assert.throws(() => parseCodingDraft(draft([{ path: "a.py", source: "x = 1\n" }, { path: "a.py/b.py", source: "x = 1\n" }]), projectGoal), /directory/);
	assert.throws(() => parseCodingDraft(draft(Array.from({ length: 9 }, (_, i) => ({ path: `m${i}.py`, source: "x = 1\n" }))), projectGoal), /eight/);
	assert.throws(() => parseCodingDraft(draft([{ path: "pkg/util.py", source: "x = 1\n" }]), { mode: "problem", language: "python" }), /one file/);
	// C++ stays flat and keeps its extensions.
	assert.throws(() => parseCodingDraft(draft([{ path: "dir/x.cpp", source: "int x;\n" }], { }), { mode: "project", language: "cpp" }), /flat/);
	assert.equal(parseCodingDraft(draft([{ path: "x.hpp", source: "int x;\n" }]), { mode: "project", language: "cpp" }).supportFiles.length, 1);
});

test("saved Python sessions parse regardless of installed runtimes; unknown languages stay unexecutable", () => {
	assert.deepEqual(codingLanguages().map(language => language.id), ["cpp", "python", "rust"]);
	assert.equal(parseCodingGoal({ mode: "problem", language: "python", goal: "g" }).language, "python");
	assert.throws(() => parseCodingGoal({ mode: "problem", language: "javascript", goal: "g" }), /local runner/);
	const original = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try { assert.equal(parseCodingDraft(draft([]), { mode: "problem", language: "python" }).exercise.language, "python"); }
	finally { process.env.PATH = original; }
});

test("generation and prompt text condition requirements on the selected language", () => {
	const python = codingInstructions("python");
	assert.match(python, /solution\.py/);
	assert.match(python, /Python 3\.11\+/);
	assert.doesNotMatch(python, /solution\.cpp|solution\.rs|C\+\+|Rust|Cargo|compile_flags/i);
	const cpp = codingInstructions("cpp");
	assert.match(cpp, /solution\.cpp/);
	assert.doesNotMatch(cpp, /solution\.py|Python/);
	assert.ok(PYTHON_DEMO_EXERCISE.tests.length > 0);
});
