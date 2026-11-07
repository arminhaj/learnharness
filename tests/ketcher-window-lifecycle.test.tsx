import React, { act } from "react";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import { KetSerializer, SGroup, type Ketcher } from "ketcher-core";
import type { StructureEditorDraft, SynthesisEditorDraft } from "../components/chemistry/synthesis-draft.ts";
import { curvedArrowsKet, ethanolKet } from "./fixtures/curved-arrows.ts";

async function waitFor(check: () => boolean, message: string) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		assert.ok(Date.now() < deadline, message);
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
	}
}

test("dirty editor teardown retains its native binding until draft serialization settles", async () => {
	const dom = parseHTML("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const capture = Symbol.for("learnharness.test.ketcher-window-lifecycle");
	type VendorProps = { onInit: (editor: Ketcher) => void };
	const globals = globalThis as typeof globalThis & { [capture]?: (props: VendorProps) => void };
	let vendorProps: VendorProps | undefined;
	globals[capture] = props => { vendorProps = props; };
	const url = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
	const vendor = url('export function Editor(props) { globalThis[Symbol.for("learnharness.test.ketcher-window-lifecycle")](props); return globalThis.React.createElement("div", { "data-testid": "vendor-canvas" }); }');
	const provider = url("export class StandaloneStructServiceProvider {}");
	const empty = url("export {};");
	const hook = registerHooks({ resolve(specifier, context, nextResolve) {
		if (context.parentURL?.includes("/components/chemistry/ketcher-editor")) {
			const replacement = specifier === "ketcher-react" ? vendor : specifier === "ketcher-standalone" ? provider : specifier.endsWith(".css") ? empty : undefined;
			if (replacement) return { url: replacement, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	} });
	const { createRoot } = await import("react-dom/client");
	const { default: KetcherEditor } = await import("../components/chemistry/ketcher-editor.tsx");
	const host = document.getElementById("root")!;
	const target = window as Window & { ketcher?: Ketcher };
	const serializer = new KetSerializer();
	const initial: SynthesisEditorDraft = {
		kind: "synthesis-draft", version: 1, activeStepId: "step-2", label: "Reaction sequence",
		steps: [{ id: "step-1", name: "Starting material", ket: ethanolKet }, { id: "step-2", name: "Intermediate", ket: curvedArrowsKet }],
	};
	let root: ReturnType<typeof createRoot> | undefined;
	let rejectPending: ((reason: Error) => void) | undefined;
	try {
		for (const failSnapshot of [false, true]) {
			vendorProps = undefined;
			const listeners = new Set<() => void>();
			let drawing = serializer.deserialize(curvedArrowsKet);
			let getKetCalls = 0;
			let resolvePending: ((ket: string) => void) | undefined;
			let boundDuringDraftDelivery: Ketcher | undefined;
			const drafts: (StructureEditorDraft | null)[] = [];
			const editor = {
				setMolecule: async (ket: string) => { drawing = serializer.deserialize(ket); },
				getKet: () => {
					getKetCalls++;
					return new Promise<string>((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
				},
				editor: {
					struct: () => drawing, selection: () => null,
					render: { ctab: { getRGroupAttachmentPointsVBoxByAtomIds: () => null } },
				},
				changeEvent: { add: (listener: () => void) => listeners.add(listener), remove: (listener: () => void) => listeners.delete(listener) },
			} as unknown as Ketcher;
			root = createRoot(host);
			await act(async () => {
				root!.render(<KetcherEditor initial={initial} onSave={() => assert.fail("teardown must not submit an answer")} onCancel={() => {}} onChange={draft => {
					boundDuringDraftDelivery = target.ketcher; drafts.push(draft);
				}} />);
			});
			assert.ok(vendorProps);
			await act(async () => { vendorProps!.onInit(editor); });
			await waitFor(() => [...host.querySelectorAll<HTMLButtonElement>("button")].some(button => button.textContent === "Add step" && !button.disabled), "editor initialization should complete");
			assert.equal(target.ketcher, editor);
			drawing.rxnArrows.get(0)!.height = 1.4;
			const finalKet = serializer.serialize(drawing);
			await act(async () => {
				listeners.forEach(listener => listener());
				root!.unmount();
			});
			root = undefined;
			assert.equal(getKetCalls, 1, "closing captures the dirty drawing before the normal debounce runs");
			assert.equal(listeners.size, 0, "teardown removes change listeners while serialization is pending");
			assert.equal(drafts.length, 0);
			assert.equal(target.ketcher, editor, "the native instance remains available to the pending serializer after unmount");
			const group = new SGroup("SUP"); group.atoms = [0];
			assert.doesNotThrow(() => SGroup.bracketPos(group, drawing), "the real S-group renderer fallback still works while the closing draft is pending");
			if (failSnapshot) {
				await act(async () => { rejectPending!(new Error("An unfinished drawing cannot be serialized")); });
				await waitFor(() => target.ketcher !== editor, "failed serialization must also release its native binding");
				assert.equal(drafts.length, 0, "a rejected snapshot does not replace the last complete draft");
			} else {
				await act(async () => { resolvePending!(finalKet); });
				await waitFor(() => drafts.length === 1 && target.ketcher !== editor, "draft delivery should finish before the binding is released");
				assert.equal(boundDuringDraftDelivery, editor, "the binding survives through the draft callback");
				const captured = drafts[0] as SynthesisEditorDraft;
				assert.equal(captured.kind, "synthesis-draft");
				assert.equal(captured.activeStepId, "step-2");
				assert.equal(captured.label, "Reaction sequence");
				assert.equal(captured.steps[0]!.ket, ethanolKet, "the inactive step is retained unchanged");
				assert.equal(captured.steps[1]!.ket, finalKet, "the modified active step is captured despite deferred serialization");
			}
			rejectPending = undefined;
			assert.equal(Object.hasOwn(target, "ketcher"), false, "no disposed editor remains globally reachable after settlement");
		}
	} finally {
		await act(async () => { root?.unmount(); rejectPending?.(new Error("Test cleanup")); });
		hook.deregister(); delete globals[capture];
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	}
});
