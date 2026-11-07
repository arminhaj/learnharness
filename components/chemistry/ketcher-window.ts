import type { Ketcher } from "ketcher-core";

interface KetcherWindow {
	ketcher?: Ketcher;
}

interface Binding {
	editor: Ketcher;
}

interface WindowBindings {
	previous?: Ketcher;
	hadOwnValue: boolean;
	entries: Binding[];
}

const windows = new WeakMap<KetcherWindow, WindowBindings>();

/** Ketcher's S-group layout code reads window.ketcher, including for Ph labels. */
export function bindKetcherWindow(editor: Ketcher, target: KetcherWindow = window as Window & KetcherWindow): () => void {
	let bindings = windows.get(target);
	// A different embed may have taken ownership since our last binding.
	if (!bindings || target.ketcher !== bindings.entries.at(-1)?.editor) {
		bindings = { previous: target.ketcher, hadOwnValue: Object.hasOwn(target, "ketcher"), entries: [] };
		windows.set(target, bindings);
	}
	const owned = bindings;
	const binding = { editor };
	owned.entries.push(binding);
	target.ketcher = editor;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const index = owned.entries.indexOf(binding);
		const wasCurrent = index === owned.entries.length - 1;
		owned.entries.splice(index, 1);
		if (windows.get(target) !== owned) return;
		if (wasCurrent && target.ketcher === editor) {
			const previous = owned.entries.at(-1);
			if (previous) target.ketcher = previous.editor;
			else if (owned.hadOwnValue) target.ketcher = owned.previous;
			else delete target.ketcher;
		}
		if (!owned.entries.length) windows.delete(target);
	};
}
