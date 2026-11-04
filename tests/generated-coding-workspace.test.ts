import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-generated-coding-"));
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(data, "auth.json");
after(() => fs.rmSync(data, { recursive: true, force: true }));

const { codingGenerationResponse } = await import("../src/server/coding-generation.ts");
const { getCodingSession, recentCodingSessions } = await import("../src/server/coding-sessions.ts");
const { codeWorkspacesResponse } = await import("../src/server/code-workspaces.ts");

function post(route: string, body: unknown) {
	return new Request(`http://127.0.0.1:3000/api/${route}`, {
		method: "POST",
		headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

const goal = { mode: "project", language: "cpp", goal: "Implement one service feature", contextFiles: [{ name: "service.hpp", content: "int amount(int);" }] };
const draft = {
	title: "Calculate a charge",
	brief: "Implement the charge function for the local service.",
	hint: "Use the amount from the request.",
	reference: "The driver reads a number and prints the returned charge.",
	simulation: true,
	exercise: {
		starterCode: "int amount(int input) { return 0; }",
		tests: [{ name: "One charge", stdin: "4\n", expectedStdout: "8\n" }],
	},
	supportFiles: [{
		path: "driver.cpp",
		source: "#include <iostream>\nint amount(int);\nint main() { int x; std::cin >> x; std::cout << amount(x) << '\\n'; }",
	}],
};

test("generated project reopens with its supporting files and runs its checks", async t => {
	const response = await codingGenerationResponse(post("coding-sessions", goal), async input => {
		assert.deepEqual(input, goal);
		return draft;
	});
	assert.equal(response.status, 201);
	const { id } = await response.json() as { id: string };
	assert.equal(getCodingSession(id)?.simulation, true);
	assert.equal(recentCodingSessions()[0]?.id, id);
	assert.equal(fs.readFileSync(path.join(data, "coding-sessions", `${id}.json`), "utf8").includes("service.hpp"), false);

	const command = { chatId: "coding", problemCallId: id };
	const load = await codeWorkspacesResponse(post("code-workspaces", { ...command, action: "load" }));
	assert.equal(load.status, 200);
	const workspace = await load.json() as { revision: string; path: string; lastRun?: unknown };
	assert.equal(workspace.lastRun, undefined);
	assert.equal(fs.readFileSync(path.join(path.dirname(workspace.path), "driver.cpp"), "utf8"), draft.supportFiles[0]?.source);

	const save = await codeWorkspacesResponse(post("code-workspaces", {
		...command, action: "save", source: "int amount(int input) { return input * 2; }", expectedRevision: workspace.revision,
	}));
	assert.equal(save.status, 200);
	const checked = await codeWorkspacesResponse(post("code-workspaces", { ...command, action: "check" }));
	assert.equal(checked.status, 200);
	const result = await checked.json() as { lastRun: { status: string; tests: { status: string }[] } };
	if (result.lastRun.status === "unavailable") t.diagnostic("Local C++ compiler unavailable");
	else {
		assert.equal(result.lastRun.status, "passed");
		assert.equal(result.lastRun.tests[0]?.status, "passed");
	}
});

test("rejects path traversal in a generated project before publishing it", async () => {
	const before = recentCodingSessions();
	const response = await codingGenerationResponse(post("coding-sessions", goal), async () => ({
		...draft,
		supportFiles: [{ path: "../driver.cpp", source: "int main() {}" }],
	}));
	assert.equal(response.status, 502);
	assert.deepEqual(recentCodingSessions(), before);
});
