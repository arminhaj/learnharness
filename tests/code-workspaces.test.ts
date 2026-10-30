import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { CODE_DEMO_EXERCISE, type CodeExercise, type CodeRunResult } from "../src/core/code-workspace.ts";
import { codeWorkspaceRequestAuthorized, codeWorkspacesResponse, createCodeWorkspaceService } from "../src/server/code-workspaces.ts";
import type { runCodeExercise } from "../src/server/code-runner.ts";

const roots: string[] = [];
after(() => roots.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));
function fixture(runner?: typeof runCodeExercise) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-test-")); roots.push(root);
	let active = true;
	const opened: string[] = [];
	const service = createCodeWorkspaceService({
		directory: path.join(root, "workspaces"),
		getExercise: () => { if (!active) throw new Error("Exercise ended"); return CODE_DEMO_EXERCISE; },
		runner: runner ?? (async (input) => ({ id: randomUUID(), workspaceId: input.workspaceId, source: input.source, revision: input.revision, language: input.exercise.language, status: "tests_failed", compiler: "test compiler", stdout: "", stderr: "", tests: [], createdAt: new Date().toISOString() })),
		openEditor: async (file, editor) => { opened.push(`${editor}:${file}`); },
	});
	const ids = { chatId: "fixture", problemCallId: "problem_1" };
	return { root, service, ids, opened, conclude: () => { active = false; } };
}

test("workspace creates starter scaffolding, persists drafts, and opens only its own file", async () => {
	const { service, ids, opened } = fixture();
	const initial = await service.execute({ ...ids, action: "load" });
	assert.equal(initial.source, CODE_DEMO_EXERCISE.starterCode);
	assert.equal(initial.filename, "solution.cpp");
	assert.equal(fs.readFileSync(path.join(path.dirname(initial.path), "compile_flags.txt"), "utf8"), "-std=c++20\n-Wall\n-Wextra\n");
	const saved = await service.execute({ ...ids, action: "save", source: "int main() {}", expectedRevision: initial.revision });
	assert.notEqual(saved.revision, initial.revision);
	assert.equal((await service.execute({ ...ids, action: "load" })).source, "int main() {}");
	await service.execute({ ...ids, action: "open", editor: "vscode" });
	assert.deepEqual(opened, [`vscode:${initial.path}`]);
});

test("external edits cause conflicts and are never silently overwritten", async () => {
	const { service, ids } = fixture();
	const initial = await service.execute({ ...ids, action: "load" });
	fs.writeFileSync(initial.path, "// changed externally\n");
	await assert.rejects(service.execute({ ...ids, action: "save", source: "old draft", expectedRevision: initial.revision }), /another editor/);
	assert.equal(fs.readFileSync(initial.path, "utf8"), "// changed externally\n");
	assert.equal((await service.execute({ ...ids, action: "load" })).source, "// changed externally\n");
});

test("checks snapshot the saved source and submissions reject stale or foreign results", async () => {
	const { service, ids, conclude } = fixture();
	const initial = await service.execute({ ...ids, action: "load" });
	const checked = await service.execute({ ...ids, action: "check", source: "caller supplied code is not authoritative" });
	const run = checked.lastRun!;
	assert.equal(run.source, initial.source);
	assert.deepEqual(service.getRunForSubmission(ids.chatId, ids.problemCallId, run.id), run);
	assert.throws(() => service.getRunForSubmission(ids.chatId, "different_problem", run.id));
	fs.writeFileSync(initial.path, "int main() { return 2; }");
	assert.throws(() => service.getRunForSubmission(ids.chatId, ids.problemCallId, run.id), /changed since/);
	conclude();
	assert.throws(() => service.getRunForSubmission(ids.chatId, ids.problemCallId, run.id), /Exercise ended/);
});

test("source symlinks and directory symlinks cannot escape the workspace", async () => {
	const { service, root, ids } = fixture();
	const initial = await service.execute({ ...ids, action: "load" });
	const other = path.join(root, "other.cpp"); fs.writeFileSync(other, "private text");
	fs.unlinkSync(initial.path); fs.symlinkSync(other, initial.path);
	await assert.rejects(service.execute({ ...ids, action: "load" }));
	await assert.rejects(service.execute({ ...ids, action: "save", source: "overwrite", expectedRevision: initial.revision }));
	assert.equal(fs.readFileSync(other, "utf8"), "private text");
	fs.unlinkSync(initial.path);
	fs.rmSync(path.dirname(initial.path), { recursive: true });
	fs.symlinkSync(root, path.dirname(initial.path));
	await assert.rejects(service.execute({ ...ids, action: "load" }), /regular directory/);
	await assert.rejects(service.execute({ chatId: "../escape", problemCallId: "p", action: "load" }), /Invalid/);
});

test("concurrent checks cannot overwrite one another and external edits remain visible", async () => {
	let release: ((value: CodeRunResult) => void) | undefined;
	let snapshot: Parameters<typeof runCodeExercise>[0] | undefined;
	const { service, ids } = fixture(async (input) => { snapshot = input; return new Promise((resolve) => { release = resolve; }); });
	const initial = await service.execute({ ...ids, action: "load" });
	const checking = service.execute({ ...ids, action: "check" });
	await assert.rejects(service.execute({ ...ids, action: "check" }), /already running/);
	fs.writeFileSync(initial.path, "// later edit");
	release!({ id: randomUUID(), workspaceId: snapshot!.workspaceId, source: snapshot!.source, revision: snapshot!.revision, language: "cpp", status: "passed", compiler: "test", stdout: "", stderr: "", tests: [], createdAt: new Date().toISOString() });
	const current = await checking;
	assert.equal(current.source, "// later edit");
	assert.notEqual(current.revision, current.lastRun!.revision);
	assert.throws(() => service.getRunForSubmission(ids.chatId, ids.problemCallId, current.lastRun!.id), /changed since/);
});

test("run requests require matching loopback host and origin, ignoring forwarded headers", async () => {
	const request = (origin: string | null, host = "localhost:3000", extras = {}) => new Request("http://localhost:3000/api/code-workspaces", { method: "POST", headers: { host, ...(origin ? { origin } : {}), ...extras } });
	assert.equal(codeWorkspaceRequestAuthorized(request("http://localhost:3000")), true);
	assert.equal(codeWorkspaceRequestAuthorized(request(null)), false);
	assert.equal(codeWorkspaceRequestAuthorized(request("https://evil.example")), false);
	assert.equal(codeWorkspaceRequestAuthorized(request("https://evil.example", "evil.example")), false);
	assert.equal(codeWorkspaceRequestAuthorized(request("http://localhost:3000", "localhost:3000", { "sec-fetch-site": "cross-site" })), false);
	assert.equal(codeWorkspaceRequestAuthorized(request("https://evil.example", "localhost:3000", { "x-forwarded-host": "evil.example" })), false);
	assert.equal((await codeWorkspacesResponse(request(null))).status, 403);
});

test("reused tool ids create a fresh workspace and an old in-flight check cannot corrupt it", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-switch-")); roots.push(root);
	let exercise: CodeExercise = CODE_DEMO_EXERCISE;
	let release: ((result: CodeRunResult) => void) | undefined;
	let snapshot: Parameters<typeof runCodeExercise>[0] | undefined;
	const service = createCodeWorkspaceService({ directory: root, getExercise: () => exercise, runner: async (input) => { snapshot = input; return new Promise((resolve) => { release = resolve; }); } });
	const ids = { chatId: "fixture", problemCallId: "call_0" };
	const first = await service.execute({ ...ids, action: "load" });
	const checking = service.execute({ ...ids, action: "check" });
	exercise = { ...CODE_DEMO_EXERCISE, starterCode: "int main() { return 42; }" };
	const second = await service.execute({ ...ids, action: "load" });
	assert.notEqual(first.id, second.id);
	assert.equal(fs.readFileSync(first.path, "utf8"), first.source);
	release!({ id: randomUUID(), workspaceId: snapshot!.workspaceId, source: snapshot!.source, revision: snapshot!.revision, language: "cpp", status: "passed", compiler: "test", stdout: "", stderr: "", tests: [], createdAt: new Date().toISOString() });
	await assert.rejects(checking, /active exercise changed/);
	const fresh = await service.execute({ ...ids, action: "load" });
	assert.equal(fresh.source, exercise.starterCode);
	assert.equal(fresh.lastRun, undefined);
});
