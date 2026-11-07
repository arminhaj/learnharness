import assert from "node:assert/strict";
import test from "node:test";
import { readStructureClipboard } from "../components/chemistry/molecule-clipboard.ts";

test("clipboard reads return text and propagate denial for the editor's manual fallback", async () => {
	assert.equal(await readStructureClipboard(async () => "CCO"), "CCO");
	await assert.rejects(readStructureClipboard(async () => { throw new Error("permission denied"); }), /permission denied/);
});

test("an unanswered clipboard permission request times out and cannot complete the old paste later", async () => {
	let complete!: (text: string) => void;
	const pending = new Promise<string>(resolve => { complete = resolve; });
	let inserted = false;
	const read = readStructureClipboard(() => pending, 5).then(() => { inserted = true; });
	await assert.rejects(read, /manually/);
	complete("CCO");
	await Promise.resolve();
	assert.equal(inserted, false);
});
