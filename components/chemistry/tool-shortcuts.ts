export const TOOL_SHORTCUT_STORAGE_KEY = "lh:chemistry:tool-shortcuts:v1";

export const EDITOR_TOOLS = [
	{ id: "select-rectangle", label: "Rectangle selection", builtIn: "Shift+Tab / Esc", group: "select" },
	{ id: "erase", label: "Erase", builtIn: "Delete / Backspace" },
	{ id: "bond-single", label: "Single bond", builtIn: "1", group: "bonds" },
	{ id: "bond-double", label: "Double bond", builtIn: "2", group: "bonds" },
	{ id: "chain", label: "Chain" },
	{ id: "charge-plus", label: "Increase charge", builtIn: "+ / =" },
	{ id: "charge-minus", label: "Decrease charge", builtIn: "−" },
	{ id: "reaction-arrow-elliptical-arc-arrow-open-angle", label: "Curved electron-pair arrow", group: "arrows" },
	{ id: "reaction-arrow-elliptical-arc-arrow-open-half-angle", label: "Curved single-electron arrow", group: "arrows" },
] as const;

export type EditorToolId = typeof EDITOR_TOOLS[number]["id"];
export type ToolShortcutMap = Partial<Record<EditorToolId, string>>;

const modifiers = new Set(["Shift", "Control", "Meta", "Alt", "AltGraph", "CapsLock"]);
const punctuation: Record<string, string> = {
	Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
	Semicolon: ";", Quote: "'", Backquote: "`", Comma: ",", Period: ".", Slash: "/", Space: "space",
};

/** Use physical letters for Alt combinations: macOS reports Option+J as ∆. */
export function toolShortcutBinding(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
	if (modifiers.has(event.key) || ["Dead", "Unidentified", "Process"].includes(event.key)) return null;
	const code = event.code ?? "";
	const key = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase()
		: /^Digit[0-9]$/.test(code) ? code.slice(5)
			: punctuation[code] ?? (event.key === " " ? "space" : event.key.toLowerCase());
	if (!key) return null;
	return [event.ctrlKey && "ctrl", event.metaKey && "meta", event.altKey && "alt", event.shiftKey && "shift", key].filter(Boolean).join("+");
}

export function shortcutError(binding: string, tool: EditorToolId, current: ToolShortcutMap): string | null {
	const keys = binding.split("+");
	const key = keys.at(-1)!;
	if (keys.includes("ctrl") || keys.includes("meta")) return "Ctrl and Command combinations are reserved for app and editing commands. Use another key or an Alt/Shift combination.";
	if (["escape", "enter", "tab"].includes(key) || /^f(?:1|2|3|5|6|10|11|12)$/.test(key) || binding === "alt+f4" || binding === "alt+space") {
		return "That combination is reserved for navigation or app commands. Choose another shortcut.";
	}
	if (!/^(?:alt\+)?(?:shift\+)?(?:[a-z0-9]|[-=\[\]\\;'`,./]|space|backspace|delete|insert|home|end|pageup|pagedown|arrowup|arrowdown|arrowleft|arrowright|f[1-9]|f1[0-9]|f2[0-4])$/.test(binding)) {
		return "Use a letter, number, punctuation key, or an Alt/Shift combination.";
	}
	const duplicate = EDITOR_TOOLS.find(other => other.id !== tool && current[other.id] === binding);
	return duplicate ? `That shortcut is already assigned to ${duplicate.label}. Clear its assignment first.` : null;
}

export function formatToolShortcut(binding: string): string {
	const names: Record<string, string> = { alt: "Alt/Option", shift: "Shift", space: "Space", backspace: "Backspace", delete: "Delete", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" };
	return binding.split("+").map(key => names[key] ?? key.toUpperCase()).join("+");
}

export function parseToolShortcuts(raw: string | null): ToolShortcutMap {
	if (!raw) return {};
	try {
		const value = JSON.parse(raw) as { version?: unknown; bindings?: unknown };
		if (!value || value.version !== 1 || !value.bindings || typeof value.bindings !== "object" || Array.isArray(value.bindings)) return {};
		const saved = value.bindings as Record<string, unknown>;
		const valid: ToolShortcutMap = {};
		for (const tool of EDITOR_TOOLS) {
			const binding = saved[tool.id];
			if (typeof binding === "string" && !shortcutError(binding, tool.id, valid)) valid[tool.id] = binding;
		}
		return valid;
	} catch { return {}; }
}

function visible(element: Element): boolean {
	if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
	const view = element.ownerDocument.defaultView;
	for (let current: Element | null = element; current; current = current.parentElement) {
		if ((current as HTMLElement).style?.display === "none" || (current as HTMLElement).style?.visibility === "hidden") return false;
		if (view?.getComputedStyle) {
			const style = view.getComputedStyle(current);
			if (style.display === "none" || style.visibility === "hidden") return false;
		}
	}
	return true;
}

export function hasEditorModal(canvas: HTMLElement): boolean {
	return [...canvas.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [data-testid="info-modal-window"], [class*="Modal-module_modalOverlay"]')].some(visible);
}

/** The clipboard textarea is Ketcher's keyboard bridge, not a text editor. */
export function shortcutCanvas(root: HTMLElement, target: EventTarget | null): HTMLElement | null {
	if (!(target instanceof root.ownerDocument.defaultView!.Element)) return null;
	const canvas = target.closest<HTMLElement>('[aria-label="Molecule drawing canvas"]');
	if (!canvas || !root.contains(canvas) || !visible(canvas) || hasEditorModal(canvas)) return null;
	const bridge = target.matches("textarea[data-cliparea]");
	if (!bridge && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return null;
	if (bridge || target === canvas || target.closest('[data-testid="canvas"]')) return canvas;
	return null;
}

function usableButton(canvas: HTMLElement, selector: string): HTMLButtonElement | null {
	return [...canvas.querySelectorAll<HTMLButtonElement>(selector)].find(button => !button.disabled && button.getAttribute("aria-disabled") !== "true" && visible(button)) ?? null;
}

/** Activate through the vendor's real action buttons so its toolbar stays in sync. */
export async function activateEditorTool(canvas: HTMLElement, id: EditorToolId, current: () => boolean): Promise<void> {
	if (!current() || hasEditorModal(canvas)) return;
	const tool = EDITOR_TOOLS.find(candidate => candidate.id === id)!;
	if (!("group" in tool)) {
		const button = usableButton(canvas, `[data-testid="left-toolbar"] button[data-testid="${id}"]`);
		if (!button) throw new Error(`${tool.label} is unavailable in this editor.`);
		if (current()) button.click();
		return;
	}
	const findOption = () => usableButton(canvas, `[data-testid="multi-tool-dropdown"] button[data-testid="${id}"]`);
	const existing = findOption();
	if (existing) { if (current()) existing.click(); return; }
	const group = canvas.querySelector(`[data-testid="left-toolbar"] [data-testid="${tool.group}-drop-down-button"]`);
	const expand = group?.querySelector('[data-testid="dropdown-expand"]');
	if (!expand || !visible(expand) || group?.querySelector("button")?.disabled) throw new Error(`${tool.label} is unavailable in this editor.`);
	await new Promise<void>((resolve, reject) => {
		const view = canvas.ownerDocument.defaultView!;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => { observer.disconnect(); if (timer) clearTimeout(timer); };
		const check = () => {
			if (!current() || hasEditorModal(canvas)) { cleanup(); resolve(); return; }
			const button = findOption();
			if (button) { cleanup(); button.click(); resolve(); }
		};
		const observer = new view.MutationObserver(check);
		observer.observe(canvas, { childList: true, subtree: true, attributes: true });
		timer = setTimeout(() => { cleanup(); reject(new Error(`Could not select ${tool.label}. Try its toolbar button.`)); }, 1000);
		const Mouse = view.MouseEvent ?? view.Event;
		expand.dispatchEvent(new Mouse("click", { bubbles: true, cancelable: true }));
		check();
	});
}
