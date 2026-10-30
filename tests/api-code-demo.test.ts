import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { API_DEMO_FILES, API_DEMO_STARTER, API_DEMO_TESTS } from "../src/core/api-code-demo.ts";
import type { CodeRunResult } from "../src/core/code-workspace.ts";
import { apiCodeDemoResponse, createApiCodeDemoService } from "../src/server/api-code-demo.ts";
import { runCodeExercise, type CodeRunnerInput } from "../src/server/code-runner.ts";

const roots: string[] = [];
after(() => roots.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));
const local = { skip: !["clang++", "g++"].some((command) => spawnSync(command, ["--version"], { timeout: 5_000 }).status === 0) };
// The solution stays in tests; it is never part of the learner's project.
const reference = `#include "library_api.hpp"
BorrowResult borrow_book(LibraryApi& library, const std::string& book_id) {
    try {
        auto book = library.find_book(book_id);
        if (!book) return BorrowResult::not_found;
        if (book->available_copies == 0) return BorrowResult::unavailable;
        return library.borrow(book_id) ? BorrowResult::borrowed : BorrowResult::unavailable;
    } catch (const ServiceUnavailable&) {
        return BorrowResult::offline;
    }
}
`;
function fixture(options: Partial<Parameters<typeof createApiCodeDemoService>[0]> = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-api-code-test-")); roots.push(directory);
	return { directory, service: createApiCodeDemoService({ directory, ...options }) };
}

test("API workspace delivers real supporting files and preserves external source changes", async () => {
	const opened: string[] = [];
	const { service } = fixture({ openEditor: async (file, editor) => { opened.push(`${editor}:${file}`); } });
	const initial = await service.execute({ action: "load" });
	assert.equal(initial.source, API_DEMO_STARTER);
	assert.equal(initial.lastCheck, undefined);
	assert.equal(initial.lastRun, undefined);
	assert.equal(initial.files.length, API_DEMO_FILES.length);
	assert.deepEqual(fs.readdirSync(path.dirname(initial.path)).sort(), API_DEMO_FILES.map((file) => file.path).sort());
	for (const file of initial.files) assert.equal(fs.readFileSync(path.join(path.dirname(initial.path), file.path), "utf8"), file.source);
	assert.match(initial.files.find((file) => file.path === "CMakeLists.txt")!.source, /solution\.cpp library_api\.cpp main\.cpp/);
	fs.writeFileSync(initial.path, reference);
	await assert.rejects(service.execute({ action: "save", source: "stale draft", expectedRevision: initial.revision }), /another editor/);
	const loaded = await service.execute({ action: "load" });
	assert.equal(loaded.source, reference);
	assert.notEqual(loaded.revision, initial.revision);
	await service.execute({ action: "open", editor: "vscode" });
	assert.deepEqual(opened, [`vscode:${initial.path}`]);
});

test("starter compiles against the real local fixture and reference passes all side-effect checks", local, async () => {
	const { service } = fixture();
	const initial = await service.execute({ action: "check" });
	assert.equal(initial.lastCheck!.status, "tests_failed");
	assert.equal(initial.lastCheck!.tests.length, API_DEMO_TESTS.length);
	assert.ok(initial.lastCheck!.tests.some((row) => row.status === "failed"));
	await service.execute({ action: "save", source: reference, expectedRevision: initial.revision });
	const checked = await service.execute({ action: "check" });
	assert.equal(checked.lastCheck!.status, "passed");
	assert.ok(checked.lastCheck!.tests.every((row) => row.status === "passed"));
	assert.equal(checked.lastCheck!.revision, checked.revision);
	assert.match(checked.lastCheck!.tests[0]!.stderr, /borrow\("dune"\) -> true/);
	const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(checked.path)), `${checked.lastCheck!.id}.json`), "utf8"));
	assert.deepEqual(fs.readdirSync(path.dirname(checked.path)).sort(), API_DEMO_FILES.map((file) => file.path).sort());
	assert.equal(saved.snapshot.files.find((file: { path: string }) => file.path === "solution.cpp").source, reference);
	assert.deepEqual(saved.snapshot.tests, API_DEMO_TESTS);
	assert.deepEqual(saved.snapshot.build.sources, ["solution.cpp", "library_api.cpp", "main.cpp"]);
});

test("custom Run executes the saved program and does not create or imply a passed check", local, async () => {
	const { service } = fixture();
	const initial = await service.execute({ action: "load" });
	await service.execute({ action: "save", source: reference, expectedRevision: initial.revision });
	const ran = await service.execute({ action: "run", stdin: "dune 7 1\n" });
	assert.equal(ran.lastRun!.status, "completed");
	assert.equal(ran.lastRun!.stdin, "dune 7 1\n");
	assert.equal(ran.lastRun!.stdout, "result: borrowed\nloans: 1\navailable: 6\n");
	assert.match(ran.lastRun!.stderr, /find_book/);
	assert.equal(ran.lastCheck, undefined);
	const invalid = await service.execute({ action: "run", stdin: "dune 99 1\n" });
	assert.equal(invalid.lastRun!.status, "runtime_error");
	assert.match(invalid.lastRun!.stderr, /Input:/);
	assert.equal(invalid.lastCheck, undefined);
});

test("returning a success label without borrowing fails state verification", local, async () => {
	const { service } = fixture();
	const initial = await service.execute({ action: "load" });
	const fake = API_DEMO_STARTER.replace("return BorrowResult::unavailable;", "return BorrowResult::borrowed;");
	await service.execute({ action: "save", source: fake, expectedRevision: initial.revision });
	const checked = await service.execute({ action: "check" });
	assert.equal(checked.lastCheck!.status, "tests_failed");
	assert.match(checked.lastCheck!.tests[0]!.stdout, /result: borrowed\nloans: 0\navailable: 2/);
	assert.equal(checked.lastCheck!.tests[0]!.status, "failed");
});

test("frozen dependency edits and symlinks are rejected without replacing the learner source", async () => {
	const { service } = fixture();
	const initial = await service.execute({ action: "load" });
	await service.execute({ action: "save", source: reference, expectedRevision: initial.revision });
	const support = path.join(path.dirname(initial.path), "library_api.cpp");
	fs.writeFileSync(support, "// externally modified implementation");
	await assert.rejects(service.execute({ action: "load" }), /library_api\.cpp changed/);
	await assert.rejects(service.execute({ action: "check" }), /library_api\.cpp changed/);
	assert.equal(fs.readFileSync(initial.path, "utf8"), reference);
	assert.equal(fs.readFileSync(support, "utf8"), "// externally modified implementation");
	fs.unlinkSync(support);
	fs.symlinkSync(initial.path, support);
	await assert.rejects(service.execute({ action: "run", stdin: "dune 1 1" }));
});

test("external edits during a check preserve the exact old snapshot and make its revision stale", async () => {
	let release!: (result: CodeRunResult) => void;
	let snapshot!: CodeRunnerInput;
	const { service } = fixture({ check: async (input) => { snapshot = input; return new Promise((resolve) => { release = resolve; }); } });
	const initial = await service.execute({ action: "load" });
	const checking = service.execute({ action: "check" });
	await assert.rejects(service.execute({ action: "run", stdin: "dune 1 1" }), /already running/);
	fs.writeFileSync(initial.path, reference);
	release({ id: randomUUID(), workspaceId: snapshot.workspaceId, source: snapshot.source, revision: snapshot.revision, language: "cpp", status: "tests_failed", compiler: "test compiler", stdout: "", stderr: "", tests: [], createdAt: new Date().toISOString() });
	const current = await checking;
	assert.equal(current.source, reference);
	assert.equal(current.lastCheck!.source, API_DEMO_STARTER);
	assert.notEqual(current.revision, current.lastCheck!.revision);
});

test("multi-file runner refuses traversal, duplicate source paths, and unlisted build inputs", async () => {
	const input: CodeRunnerInput = { workspaceId: "test", source: API_DEMO_STARTER, revision: "test", exercise: { language: "cpp", starterCode: API_DEMO_STARTER, tests: API_DEMO_TESTS } };
	await assert.rejects(runCodeExercise({ ...input, supportFiles: [{ path: "../escape.cpp", source: "" }] }), /Invalid/);
	await assert.rejects(runCodeExercise({ ...input, supportFiles: [{ path: "SOLUTION.CPP", source: "" }] }), /duplicate/);
	await assert.rejects(runCodeExercise({ ...input, compileSources: ["outside.cpp"] }), /compilation sources/);
});

test("demo API rejects nonlocal origins before any workspace or process action", async () => {
	const response = await apiCodeDemoResponse(new Request("http://localhost:3000/api/code-api-demo", { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: JSON.stringify({ action: "run", stdin: "dune 1 1" }) }));
	assert.equal(response.status, 403);
});
