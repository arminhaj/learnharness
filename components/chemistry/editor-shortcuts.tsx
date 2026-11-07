"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
	activateEditorTool, EDITOR_TOOLS, formatToolShortcut, hasEditorModal, parseToolShortcuts,
	shortcutCanvas, shortcutError, TOOL_SHORTCUT_STORAGE_KEY, toolShortcutBinding,
	type EditorToolId, type ToolShortcutMap,
} from "./tool-shortcuts";

export function EditorShortcuts({ rootRef, disabled }: { rootRef: RefObject<HTMLDivElement | null>; disabled: boolean }) {
	const panelId = useId();
	const [open, setOpen] = useState(false);
	const [bindings, setBindings] = useState<ToolShortcutMap>({});
	const [recording, setRecording] = useState<EditorToolId | null>(null);
	const [error, setError] = useState<string>();
	const [status, setStatus] = useState<string>();
	const bindingsRef = useRef(bindings);
	const recordingRef = useRef(recording);
	const disabledRef = useRef(disabled);
	const mounted = useRef(true);
	const activation = useRef(0);
	bindingsRef.current = bindings;
	recordingRef.current = recording;
	disabledRef.current = disabled;

	const save = (next: ToolShortcutMap) => {
		bindingsRef.current = next;
		setBindings(next);
		setError(undefined);
		try {
			if (Object.keys(next).length) window.localStorage.setItem(TOOL_SHORTCUT_STORAGE_KEY, JSON.stringify({ version: 1, bindings: next }));
			else window.localStorage.removeItem(TOOL_SHORTCUT_STORAGE_KEY);
		} catch {
			setError("These shortcuts work for this session, but could not be saved on this device.");
		}
	};
	const saveRef = useRef(save);
	saveRef.current = save;

	useEffect(() => {
		mounted.current = true;
		const load = () => {
			try {
				const saved = parseToolShortcuts(window.localStorage.getItem(TOOL_SHORTCUT_STORAGE_KEY));
				bindingsRef.current = saved;
				setBindings(saved);
			} catch { /* Native shortcuts remain available when storage cannot be read. */ }
		};
		load();
		const onStorage = (event: StorageEvent) => { if (event.key === TOOL_SHORTCUT_STORAGE_KEY || event.key === null) load(); };
		window.addEventListener("storage", onStorage);
		return () => {
			mounted.current = false;
			activation.current++;
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	useEffect(() => {
		if (disabled) { activation.current++; setRecording(null); }
	}, [disabled]);

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const onKey = (event: KeyboardEvent) => {
			if (disabledRef.current || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
			const canvas = root.querySelector<HTMLElement>('[aria-label="Molecule drawing canvas"]');
			if (canvas && hasEditorModal(canvas)) return;
			if (recordingRef.current) {
				event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
				if (event.key === "Escape") { setRecording(null); setError(undefined); return; }
				const binding = toolShortcutBinding(event);
				if (!binding) return;
				const issue = shortcutError(binding, recordingRef.current, bindingsRef.current);
				if (issue) { setError(issue); return; }
				const tool = EDITOR_TOOLS.find(candidate => candidate.id === recordingRef.current)!;
				saveRef.current({ ...bindingsRef.current, [recordingRef.current]: binding });
				setStatus(`${formatToolShortcut(binding)} now selects ${tool.label}.`);
				setRecording(null);
				return;
			}
			const drawing = shortcutCanvas(root, event.target);
			if (!drawing) return;
			const binding = toolShortcutBinding(event);
			const tool = EDITOR_TOOLS.find(candidate => bindingsRef.current[candidate.id] === binding);
			if (!tool) return;
			event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
			const request = ++activation.current;
			const current = () => mounted.current && request === activation.current && !disabledRef.current
				&& rootRef.current === root && drawing.isConnected
				&& root.querySelector('[aria-label="Molecule drawing canvas"]') === drawing;
			void activateEditorTool(drawing, tool.id, current).then(() => {
				if (current()) { setError(undefined); setStatus(`${tool.label} selected.`); }
			}, reason => {
				if (current()) setError(reason instanceof Error ? reason.message : "Could not activate this drawing tool.");
			});
		};
		root.addEventListener("keydown", onKey, true);
		return () => { activation.current++; root.removeEventListener("keydown", onKey, true); };
	}, [rootRef]);

	return <div className="space-y-2" data-chemistry-interactive="" data-tool-shortcuts="">
		<Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={panelId} disabled={disabled} onClick={() => {
			setOpen(value => !value); setRecording(null); setError(undefined);
		}}>Tool shortcuts</Button>
		{open && <div id={panelId} aria-label="Molecule tool shortcuts" className="space-y-2 rounded-md border p-3">
			<p className="text-xs text-muted-foreground">Assign a key or an Alt/Shift combination. Custom keys take priority while drawing; other built-in shortcuts stay available. Shortcuts are saved on this device.</p>
			<div className="max-h-56 space-y-1 overflow-auto">
				{EDITOR_TOOLS.map(tool => <div key={tool.id} className="flex flex-wrap items-center justify-between gap-2 rounded px-1 py-1.5" data-shortcut-tool={tool.id}>
					<div className="min-w-0 flex-1">
						<p className="text-sm">{tool.label}</p>
						<p className="text-xs text-muted-foreground">{recording === tool.id ? "Press your shortcut… (Esc cancels)" : bindings[tool.id] ? `Custom: ${formatToolShortcut(bindings[tool.id]!)}` : "builtIn" in tool ? `Built-in: ${tool.builtIn}` : "No shortcut assigned"}</p>
					</div>
					{recording === tool.id ? <Button type="button" variant="ghost" size="xs" onClick={() => { setRecording(null); setError(undefined); }}>Cancel recording</Button>
						: <Button type="button" variant="outline" size="xs" disabled={disabled} aria-label={`Assign shortcut for ${tool.label}`} onClick={() => { setRecording(tool.id); setError(undefined); setStatus(undefined); }}>{bindings[tool.id] ? "Change" : "Assign"}</Button>}
					{bindings[tool.id] && <Button type="button" variant="ghost" size="xs" disabled={disabled || recording !== null} aria-label={`Clear shortcut for ${tool.label}`} onClick={() => {
						const next = { ...bindingsRef.current }; delete next[tool.id]; save(next); setStatus(`Custom shortcut cleared for ${tool.label}.`);
					}}>Clear</Button>}
				</div>)}
			</div>
			<Button type="button" variant="ghost" size="xs" disabled={disabled || recording !== null || !Object.keys(bindings).length} onClick={() => { save({}); setStatus("Custom tool shortcuts reset. Built-in shortcuts remain available."); }}>Reset custom shortcuts</Button>
		</div>}
		{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
		{status && <p role="status" className="sr-only">{status}</p>}
	</div>;
}
