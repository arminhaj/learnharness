import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { CODING_LANGUAGES } from "../src/core/coding-session.ts";
import { RUST_DEMO_EXERCISE, type CodeExercise } from "../src/core/code-workspace.ts";
import { createCodeWorkspaceService } from "../src/server/code-workspaces.ts";
import { codingInstructions } from "../src/server/coding-generation.ts";
import { parseCodingDraft, parseCodingGoal } from "../src/server/coding-sessions.ts";
import { runProcess } from "../src/server/code-process.ts";
import { discoverRust } from "../src/server/rust-provider.ts";

const roots: string[] = [];
after(() => roots.forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));
const scratch = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rust-ws-")); roots.push(directory); return directory; };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const found = await discoverRust(undefined, runProcess);
const local = { skip: found.compiler ? false : "no Rust 1.56+ compiler found" };

const support = [
	{ path: "util/mod.rs", source: "pub mod leaf;\npub fn base() -> i64 {\n    40\n}\n" },
	{ path: "util/leaf.rs", source: "pub const BONUS: i64 = 2;\n" },
	{ path: "empty.rs", source: "" },
];
const exercise: CodeExercise = {
	language: "rust",
	starterCode: "mod empty;\nmod util;\nfn main() {\n    let mut text = String::new();\n    std::io::stdin().read_line(&mut text).unwrap();\n    let n: i64 = text.trim().parse().unwrap();\n    println!(\"{}\", n + util::base() * 0 + util::leaf::BONUS * 0);\n}\n",
	tests: [{ name: "echo", stdin: "5\n", expectedStdout: "5\n" }],
};
const ids = { chatId: "fixture", problemCallId: "problem_1" };
/** Legacy workspace identity: the unversioned exercise projection plus support files. */
const workspaceId = (value: CodeExercise, files = support) => sha(`${ids.chatId}\0${ids.problemCallId}\0${sha(JSON.stringify(files.length ? { exercise: value, supportFiles: files } : value))}`);
const service = (root: string, files = support) => createCodeWorkspaceService({ directory: path.join(root, "workspaces"), getExercise: () => ({ ...exercise, supportFiles: files }) });

test("a Rust workspace creates nested and empty modules privately, with no Cargo or editor scaffolding", async () => {
	const view = await service(scratch()).execute({ ...ids, action: "load" });
	const directory = path.dirname(view.path);
	assert.equal(view.filename, "solution.rs");
	assert.equal(path.basename(directory), workspaceId(exercise), "legacy identity projection, unchanged");
	assert.equal(fs.readFileSync(path.join(directory, "util/leaf.rs"), "utf8"), "pub const BONUS: i64 = 2;\n");
	assert.equal(fs.statSync(path.join(directory, "empty.rs")).size, 0, "an empty module keeps its exact bytes");
	assert.equal(fs.statSync(path.join(directory, "util")).mode & 0o777, 0o700);
	assert.deepEqual(fs.readdirSync(directory).sort(), ["empty.rs", "solution.rs", "util", "workspace.json"]);
});

test("a generated workspace reopens, checks, persists, and resolves for submission", local, async () => {
	const svc = service(scratch());
	const first = await svc.execute({ ...ids, action: "load" });
	const checked = await svc.execute({ ...ids, action: "check" });
	assert.equal(checked.lastRun!.status, "passed", JSON.stringify(checked.lastRun!.tests) + checked.lastRun!.stderr);
	assert.equal(checked.lastRun!.detail!.profile.id, "rust2021-stdio");
	assert.deepEqual(svc.getRunForSubmission(ids.chatId, ids.problemCallId, checked.lastRun!.id), checked.lastRun);
	assert.equal((await svc.execute({ ...ids, action: "load" })).lastRun!.id, checked.lastRun!.id, "reopening keeps the saved check");
	const edited = await svc.execute({ ...ids, action: "save", source: `${exercise.starterCode}// edit\n`, expectedRevision: checked.revision });
	assert.throws(() => svc.getRunForSubmission(ids.chatId, ids.problemCallId, checked.lastRun!.id), /changed since this check/);
	const again = await svc.execute({ ...ids, action: "check", expectedRevision: edited.revision });
	assert.equal(svc.getRunForSubmission(ids.chatId, ids.problemCallId, again.lastRun!.id).id, again.lastRun!.id);
	assert.equal(first.id, again.id);
});

test("a modified support module, including an empty one, is detected; an intermediate symlink is refused", async () => {
	const svc = service(scratch());
	const view = await svc.execute({ ...ids, action: "load" });
	const directory = path.dirname(view.path);
	fs.writeFileSync(path.join(directory, "empty.rs"), "// changed\n");
	await assert.rejects(svc.execute({ ...ids, action: "load" }), /Restore the supplied contents of empty\.rs/);
	fs.writeFileSync(path.join(directory, "empty.rs"), "");
	const outside = scratch();
	fs.cpSync(path.join(directory, "util"), path.join(outside, "util"), { recursive: true });
	fs.rmSync(path.join(directory, "util"), { recursive: true });
	fs.symlinkSync(path.join(outside, "util"), path.join(directory, "util"));
	await assert.rejects(svc.execute({ ...ids, action: "load" }), /link or file/);
});

const draft = (supportFiles: unknown[], extra: Record<string, unknown> = {}) => ({
	title: "T", brief: "B", hint: "H", reference: "R", supportFiles, simulation: false,
	exercise: { starterCode: "fn main() {}\n", tests: [{ name: "t", stdin: "", expectedStdout: "" }], ...extra },
});
const projectGoal = { mode: "project" as const, language: "rust" as const };

test("generated Rust projects accept clean relative .rs modules, exact bytes, and reject everything else", () => {
	const padded = "\n\npub const X: i32 = 1;   \n\n";
	const parsed = parseCodingDraft(draft([{ path: "util/mod.rs", source: padded }, { path: "empty.rs", source: "" }, { path: "a/b/c.rs", source: "// c\n" }]), projectGoal);
	assert.equal(parsed.exercise.language, "rust");
	assert.deepEqual(parsed.supportFiles, [{ path: "util/mod.rs", source: padded }, { path: "empty.rs", source: "" }, { path: "a/b/c.rs", source: "// c\n" }]);
	for (const bad of ["../x.rs", "/abs.rs", "a//b.rs", "./a.rs", "a\\b.rs", ".hidden.rs", "pkg/.x.rs", "Cargo.toml", "build.rs/x.txt", "notes.txt", "x.py", "x.cpp", "solution.rs", "SOLUTION.RS", `${"d/".repeat(40)}x.rs`]) {
		assert.throws(() => parseCodingDraft(draft([{ path: bad, source: "" }]), projectGoal), /./, bad);
	}
	assert.throws(() => parseCodingDraft(draft([{ path: "a.rs", source: "" }, { path: "a.rs/b.rs", source: "" }]), projectGoal), /directory/);
	assert.throws(() => parseCodingDraft(draft([{ path: "x.rs", source: "a\0b" }]), projectGoal), /text/);
	assert.throws(() => parseCodingDraft(draft([{ path: "x.rs", source: "" }, { path: "X.rs", source: "" }]), projectGoal), /unique/);
	assert.throws(() => parseCodingDraft(draft([{ path: "x.rs", source: "" }], { cargo: { dependencies: { serde: "1" } } }), projectGoal), /Dependency declarations/);
	assert.throws(() => parseCodingDraft(draft([{ path: "x.rs", source: "" }]), { mode: "problem", language: "rust" }), /one file/);
});

test("Rust is selectable by name and alias at parse time without a compiler", () => {
	assert.ok(CODING_LANGUAGES.some(language => language.id === "rust"));
	assert.equal(parseCodingGoal({ mode: "problem", language: "rust", goal: "g" }).language, "rust");
	assert.throws(() => parseCodingGoal({ mode: "problem", language: "rs", goal: "g" }), /local runner/, "coding goals take canonical ids, as for Python");
	const original = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try { assert.equal(parseCodingDraft(draft([]), { mode: "problem", language: "rust" }).exercise.language, "rust"); }
	finally { process.env.PATH = original; }
});

test("generation and prompt text condition requirements on the selected language", () => {
	const rust = codingInstructions("rust");
	assert.match(rust, /solution\.rs/);
	assert.match(rust, /Rust 2021/);
	assert.match(rust, /mod helpers;/);
	assert.doesNotMatch(rust, /solution\.cpp|solution\.py|C\+\+|Python|compile_flags|__init__/i);
	for (const other of ["cpp", "python"]) assert.doesNotMatch(codingInstructions(other), /Rust|rustc|solution\.rs|Cargo/);
});
