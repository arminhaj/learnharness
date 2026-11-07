import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { Value } from "typebox/value";
import { CODING_LANGUAGES } from "../src/core/coding-session.ts";
import { CODE_DEMO_EXERCISE, parseCodeExercise, type CodeRunResult } from "../src/core/code-workspace.ts";
import { CODE_LANGUAGES, CODE_PROFILES, codeLanguagePromptSection, executableCodeLanguages, executableProfileFor, findCodeLanguage, findCodeProfile } from "../src/core/code-language-catalog.ts";
import { normalizeCodeActivity, validCodeResourcePath } from "../src/core/code-activity.ts";
import { codeExerciseSchema } from "../src/core/code-exercise-schema.ts";
import { askInputSchema } from "../src/core/question-core.ts";
import { problemInputObject } from "../src/agent/tools/practice.ts";
import { codingLanguages, parseCodingGoal } from "../src/server/coding-sessions.ts";
import { createCodeWorkspaceService } from "../src/server/code-workspaces.ts";

const roots: string[] = [];
after(() => roots.forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("catalog registers only executable C++ and fails closed for everything else", () => {
	assert.deepEqual(executableCodeLanguages().map(language => language.id), ["cpp", "python"]);
	assert.deepEqual(CODE_PROFILES.map(profile => profile.id), ["cpp20-stdio", "python3-stdio"]);
	for (const alias of ["cpp", "C++", " cxx "]) assert.equal(executableProfileFor(alias)?.id, "cpp20-stdio");
	for (const alias of ["python", "PY", " python3 "]) assert.equal(executableProfileFor(alias)?.id, "python3-stdio");
	for (const name of ["rust", "javascript", "", "c", undefined, 3]) assert.equal(executableProfileFor(name), undefined);
	assert.equal(findCodeLanguage("rust")?.profiles.length, 0, "Rust is named but not executable");
	for (const language of CODE_LANGUAGES) for (const id of language.profiles) assert.ok(CODE_PROFILES.some(profile => profile.id === id && profile.language === language.id));
	assert.deepEqual(CODING_LANGUAGES.map(language => language.id), CODE_LANGUAGES.map(language => language.id));
	assert.deepEqual(codingLanguages().map(language => language.id), ["cpp", "python"]);
	assert.throws(() => parseCodingGoal({ mode: "problem", language: "rust", goal: "x" }), /local runner/);
});

test("parser, Teaching schema, and Practice schema agree on executable languages", () => {
	const exercise = { language: "cpp", starterCode: "int main() {}", tests: [{ name: "t", stdin: "", expectedStdout: "" }] };
	const teaching = (value: unknown) => Value.Check(askInputSchema, { question: "q", codeExercise: value });
	const practice = (value: unknown) => Value.Check(problemInputObject, { statement: "s", mode: "recall", modelSolution: "m", codeExercise: value });
	for (const check of [teaching, practice]) assert.equal(check(exercise), true);
	// Practice leaves alias/unknown handling to the parser, which fails closed.
	for (const language of ["rust", "javascript"]) assert.equal(practice({ ...exercise, language }), true);
	assert.equal(teaching({ ...exercise, language: "python" }), true);
	assert.equal(teaching({ ...exercise, language: "py" }), false, "Teaching admits canonical ids only; the parser accepts aliases");
	assert.equal(parseCodeExercise({ ...exercise, language: "py" }).language, "python");
	assert.equal(teaching({ ...exercise, language: "rust" }), false);
	assert.equal(teaching({ ...exercise, language: "javascript" }), false);
	for (const language of ["rust", "javascript"]) assert.throws(() => parseCodeExercise({ ...exercise, language }), /supports C\+\+20 and Python 3\.11\+/);
	assert.equal(parseCodeExercise({ ...exercise, language: "C++" }).language, "cpp");
	assert.equal(typeof codeExerciseSchema({ languageInput: "tolerant", closed: true }), "object");
});

test("parser keeps the exact legacy shape, property order, and source bytes", () => {
	const source = "  // keep\r\nint main() {}  \n";
	const parsed = parseCodeExercise({ language: "CXX", starterCode: source, tests: [{ name: " a ", stdin: "x", expectedStdout: "y", extra: 1 }], cargo: {} });
	assert.equal(JSON.stringify(parsed), JSON.stringify({ language: "cpp", starterCode: source, tests: [{ name: "a", stdin: "x", expectedStdout: "y" }] }));
});

test("normalizer produces the internal spec without mutating its input", () => {
	const exercise = parseCodeExercise(CODE_DEMO_EXERCISE);
	const before = JSON.stringify(exercise);
	const spec = normalizeCodeActivity(exercise, [{ path: "util.hpp", source: "#pragma once\n" }, { path: "util.cpp", source: "" }]);
	assert.equal(JSON.stringify(exercise), before);
	assert.equal(spec.schemaVersion, 2);
	assert.deepEqual(spec.profile, { id: "cpp20-stdio", version: 1 });
	assert.deepEqual(spec.resources.map(resource => [resource.path, resource.role, resource.editable]), [["solution.cpp", "learner", true], ["util.hpp", "support", false], ["util.cpp", "support", false]]);
	assert.equal(spec.resources[0]!.content, exercise.starterCode);
	assert.equal(spec.target.entryResourceId, spec.resources[0]!.id);
	assert.equal(spec.check.kind, "stdio");
	assert.deepEqual(spec.check.cases.map(({ name, stdin, expectedStdout }) => ({ name, stdin, expectedStdout })), exercise.tests);
	assert.throws(() => normalizeCodeActivity({ ...exercise, language: "rust" }), /No executable profile/);
	assert.throws(() => normalizeCodeActivity(exercise, [{ path: "SOLUTION.cpp", source: "" }]), /Duplicate/);
	assert.throws(() => normalizeCodeActivity(exercise, [{ path: "../x.cpp", source: "" }]), /Invalid resource path/);
});

test("resource paths must be relative and clean", () => {
	for (const good of ["a.cpp", "dir/a.hpp"]) assert.equal(validCodeResourcePath(good), true);
	for (const bad of ["", "/a", "../a", "a/../b", "a//b", "./a", "a\\b", "C:a", "a\0b", 4]) assert.equal(validCodeResourcePath(bad), false);
});

function seed(exercise: typeof CODE_DEMO_EXERCISE, supportFiles: { path: string; source: string }[], occurrence: string, expectedId: string) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-compat-test-")); roots.push(root);
	const directory = path.join(root, "workspaces", expectedId);
	fs.mkdirSync(directory, { recursive: true });
	const exerciseHash = sha(JSON.stringify(supportFiles.length ? { exercise, supportFiles } : exercise));
	const edited = "// learner edit\r\nint main() { return 0; }\n";
	const run: CodeRunResult = { id: randomUUID(), workspaceId: expectedId, source: edited, revision: sha(edited), language: "cpp", status: "tests_failed", compiler: "clang++", stdout: "", stderr: "", tests: [], createdAt: "2026-01-01T00:00:00.000Z" };
	fs.writeFileSync(path.join(directory, "workspace.json"), JSON.stringify({ id: expectedId, chatId: "fixture", problemCallId: "problem_1", exerciseHash, lastRunId: run.id }));
	fs.writeFileSync(path.join(directory, "solution.cpp"), edited);
	fs.writeFileSync(path.join(directory, `${run.id}.json`), JSON.stringify(run));
	for (const file of supportFiles) fs.writeFileSync(path.join(directory, file.path), file.source);
	const service = createCodeWorkspaceService({
		directory: path.join(root, "workspaces"),
		getExercise: () => ({ ...exercise, ...(supportFiles.length ? { supportFiles } : {}) }),
		...(occurrence ? { getOccurrence: () => occurrence } : {}),
		runner: async () => { throw new Error("must not run"); },
	});
	return { service, run, edited, directory };
}

test("pre-existing workspaces reopen under their exact historical identity and resolve for submission", async () => {
	// Golden IDs were computed with the pre-change implementation.
	const plain = seed(CODE_DEMO_EXERCISE, [], "", "389e9dc4fd145d4a14c3686d7ddd5adf21ce1bbc2d0822d1f89ebbf1f3231877");
	const view = await plain.service.execute({ chatId: "fixture", problemCallId: "problem_1", action: "load" });
	assert.equal(view.id, "389e9dc4fd145d4a14c3686d7ddd5adf21ce1bbc2d0822d1f89ebbf1f3231877");
	assert.equal(view.source, plain.edited);
	assert.equal(view.revision, sha(plain.edited));
	assert.deepEqual(view.lastRun, plain.run);
	assert.equal("detail" in view.lastRun!, false);
	assert.deepEqual(plain.service.getRunForSubmission("fixture", "problem_1", plain.run.id), plain.run);
	assert.deepEqual(fs.readdirSync(plain.directory).sort(), ["solution.cpp", "workspace.json", `${plain.run.id}.json`].sort(), "no scaffolding added to an existing workspace");

	const support = [{ path: "util.hpp", source: "#pragma once\n" }];
	const withSupport = seed(CODE_DEMO_EXERCISE, support, "occ", "e7cea10122107600e24a6ccb4fd62654bfa555181a51af6bc4ed0bbb7e4b9a06");
	const second = await withSupport.service.execute({ chatId: "fixture", problemCallId: "problem_1", action: "load" });
	assert.equal(second.id, "e7cea10122107600e24a6ccb4fd62654bfa555181a51af6bc4ed0bbb7e4b9a06");
	assert.deepEqual(withSupport.service.getRunForSubmission("fixture", "problem_1", withSupport.run.id), withSupport.run);
});

test("saved-content parsing does not depend on runtime readiness or PATH", () => {
	const original = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try { assert.equal(parseCodeExercise(CODE_DEMO_EXERCISE).language, "cpp"); assert.ok(normalizeCodeActivity(CODE_DEMO_EXERCISE)); }
	finally { process.env.PATH = original; }
});

test("the generated capability section reaches Teaching and Practice, survives overrides, and omits the prober", async () => {
	const section = codeLanguagePromptSection();
	for (const language of executableCodeLanguages()) {
		for (const profile of language.profiles.map(findCodeProfile)) {
			assert.ok(section.includes(`\`${language.id}\` (${profile!.label}): ${profile!.authoring.starterCode} ${profile!.authoring.runtime}`));
		}
	}
	assert.doesNotMatch(section, /rust|Cargo/i);
	assert.equal(codeLanguagePromptSection(), section, "deterministic");
	const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
	for (const kind of ["teacher", "practice"] as const) assert.ok(composeInstructions(kind).endsWith(section), `${kind} ends with the generated section`);
	assert.ok(!composeInstructions("prober").includes("Executable coding languages"));
	// The editable prose carries no independent language inventory.
	for (const file of ["src/agent/prompts/teacher/25-coding.md", "src/agent/prompts/practice/20-code-exercises.md"]) {
		const text = fs.readFileSync(file, "utf8");
		for (const language of executableCodeLanguages()) assert.ok(!text.includes(`\`${language.id}\` (`), `${file} must not restate ${language.id}`);
		assert.doesNotMatch(text, /`rust`|Cargo|currently the only executable language/i);
	}
});
