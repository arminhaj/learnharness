import assert from "node:assert/strict";
import test from "node:test";
import { Atom, SGroup, Struct, Vec2, type Ketcher } from "ketcher-core";
import { bindKetcherWindow } from "../components/chemistry/ketcher-window.ts";

type KetcherTarget = { ketcher?: Ketcher };

function editorFixture() {
	const inspected: number[][] = [];
	const editor = {
		editor: {
			render: {
				ctab: { getRGroupAttachmentPointsVBoxByAtomIds: (atoms: number[]) => { inspected.push([...atoms]); return null; } },
			},
		},
	} as unknown as Ketcher;
	return { editor, inspected };
}

test("the live Ketcher binding fixes the actual SUP-group renderer fallback used by Clean Up", () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	const target: KetcherTarget = {};
	Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: target });
	let dispose: (() => void) | undefined;
	try {
		const molecule = new Struct();
		molecule.atoms.add(new Atom({ label: "C", pp: new Vec2(0, 0) }));
		const phenylGroup = new SGroup("SUP");
		phenylGroup.atoms = [0];
		assert.throws(() => SGroup.bracketPos(phenylGroup, molecule), /Cannot read properties of undefined \(reading 'editor'\)/, "the real dependency reproduces the reported error without the embedded instance");
		const { editor, inspected } = editorFixture();
		dispose = bindKetcherWindow(editor, target);
		assert.equal(target.ketcher, editor);
		assert.doesNotThrow(() => SGroup.bracketPos(phenylGroup, molecule));
		assert.deepEqual(inspected, [[0]], "the native S-group operation uses the bound editor's renderer");
		assert.ok(phenylGroup.bracketBox);
		dispose();
		assert.equal(target.ketcher, undefined, "closing the owning editor releases the global instance");
		assert.equal(Object.hasOwn(target, "ketcher"), false, "a formerly absent global does not leave a stale own property");
	} finally {
		dispose?.();
		if (previous) Object.defineProperty(globalThis, "window", previous);
		else delete (globalThis as Record<string, unknown>).window;
	}
});

test("nested bindings restore the prior live editor and preserve an existing external instance", () => {
	const external = editorFixture().editor;
	const first = editorFixture().editor;
	const second = editorFixture().editor;
	const target: KetcherTarget = { ketcher: external };
	const disposeFirst = bindKetcherWindow(first, target);
	const disposeSecond = bindKetcherWindow(second, target);
	assert.equal(target.ketcher, second);
	disposeSecond();
	assert.equal(target.ketcher, first);
	disposeFirst();
	assert.equal(target.ketcher, external);
	disposeSecond(); disposeFirst();
	assert.equal(target.ketcher, external, "duplicate cleanup calls cannot overwrite the prior owner");
});

test("out-of-order cleanup never resurrects a disposed editor", () => {
	const external = editorFixture().editor;
	const first = editorFixture().editor;
	const second = editorFixture().editor;
	const third = editorFixture().editor;
	const target: KetcherTarget = { ketcher: external };
	const disposeFirst = bindKetcherWindow(first, target);
	const disposeSecond = bindKetcherWindow(second, target);
	const disposeThird = bindKetcherWindow(third, target);
	disposeSecond();
	assert.equal(target.ketcher, third);
	disposeFirst();
	assert.equal(target.ketcher, third, "an older editor's late cleanup leaves the active editor bound");
	disposeThird();
	assert.equal(target.ketcher, external, "cleanup skips all previously disposed instances");
});

test("separate bindings of the same instance still have independent lifetimes", () => {
	const external = editorFixture().editor;
	const editor = editorFixture().editor;
	const target: KetcherTarget = { ketcher: external };
	const disposeFirst = bindKetcherWindow(editor, target);
	const disposeSecond = bindKetcherWindow(editor, target);
	disposeFirst();
	assert.equal(target.ketcher, editor, "the second binding remains live even when its editor identity is the same");
	disposeSecond();
	assert.equal(target.ketcher, external);
});

test("late cleanup preserves a subsequent external assignment and fresh bindings restore that new owner", () => {
	const original = editorFixture().editor;
	const outside = editorFixture().editor;
	const target: KetcherTarget = { ketcher: original };
	const disposeFirst = bindKetcherWindow(editorFixture().editor, target);
	const disposeSecond = bindKetcherWindow(editorFixture().editor, target);
	target.ketcher = outside;
	disposeFirst(); disposeSecond();
	assert.equal(target.ketcher, outside, "an embedding host's later assignment wins over old cleanup callbacks");
	const disposeNext = bindKetcherWindow(editorFixture().editor, target);
	disposeNext();
	assert.equal(target.ketcher, outside, "the next editor captures the current external owner, not a stale baseline");
});

test("bindings on different windows do not share ownership state", () => {
	const firstExternal = editorFixture().editor;
	const secondExternal = editorFixture().editor;
	const secondEditor = editorFixture().editor;
	const first: KetcherTarget = { ketcher: firstExternal };
	const second: KetcherTarget = { ketcher: secondExternal };
	const disposeFirst = bindKetcherWindow(editorFixture().editor, first);
	const disposeSecond = bindKetcherWindow(secondEditor, second);
	disposeFirst();
	assert.equal(first.ketcher, firstExternal);
	assert.equal(second.ketcher, secondEditor);
	disposeSecond();
	assert.equal(second.ketcher, secondExternal);
});

test("an external ownership change between mounts cannot be overwritten by an older mount's cleanup", () => {
	const original = editorFixture().editor;
	const outside = editorFixture().editor;
	const newest = editorFixture().editor;
	const target: KetcherTarget = { ketcher: original };
	const disposeOld = bindKetcherWindow(editorFixture().editor, target);
	target.ketcher = outside;
	const disposeNew = bindKetcherWindow(newest, target);
	disposeOld();
	assert.equal(target.ketcher, newest);
	disposeNew();
	assert.equal(target.ketcher, outside, "the new mount restores the host it actually replaced");
});
