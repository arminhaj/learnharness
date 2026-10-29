"use client";

import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { cpp } from "@codemirror/lang-cpp";
import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import { cn } from "@/lib/utils";

export interface CodeEditorProps {
	value: string;
	onChange: (value: string) => void;
	language?: string;
	disabled?: boolean;
	onSubmit?: () => void;
	ariaLabel?: string;
	autoFocus?: boolean;
	className?: string;
}

// The editor is a separate input surface: prose editing and path chips retain
// their own selection model. Language extensions can be added independently of
// compiler adapters; unsupported languages still get plain code editing.
const languageExtension = (language: string) => language === "cpp" ? cpp() : [];

const colors = HighlightStyle.define([
	{ tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: "light-dark(#7c3aed, #c4b5fd)" },
	{ tag: [tags.typeName, tags.className], color: "light-dark(#0369a1, #7dd3fc)" },
	{ tag: [tags.string, tags.character], color: "light-dark(#047857, #6ee7b7)" },
	{ tag: [tags.number, tags.bool], color: "light-dark(#b45309, #fcd34d)" },
	{ tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
	{ tag: tags.function(tags.variableName), color: "light-dark(#1d4ed8, #93c5fd)" },
	{ tag: tags.meta, color: "light-dark(#be185d, #f9a8d4)" },
]);

const editorTheme = EditorView.theme({
	"&": { color: "var(--foreground)", backgroundColor: "transparent", fontSize: "13px" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--font-jetbrains), monospace", overflow: "auto", maxHeight: "min(50vh, 520px)" },
	".cm-content": { padding: "12px 0", minHeight: "110px", caretColor: "var(--foreground)" },
	".cm-line": { padding: "0 16px 0 8px" },
	".cm-gutters": { backgroundColor: "transparent", color: "var(--muted-foreground)", borderRight: "1px solid var(--border)" },
	".cm-lineNumbers .cm-gutterElement": { minWidth: "36px", paddingRight: "10px" },
	".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 45%, transparent)" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--primary) 22%, transparent)" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
	".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--primary) 20%, transparent)", outline: "1px solid var(--border)" },
	".cm-tooltip": { backgroundColor: "var(--popover)", color: "var(--foreground)", border: "1px solid var(--border)", borderRadius: "6px" },
	".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--foreground)" },
});

export function CodeEditor({ value, onChange, language = "cpp", disabled = false, onSubmit, ariaLabel = "Code", autoFocus = false, className }: CodeEditorProps) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const callbacks = useRef({ onChange, onSubmit, disabled });
	callbacks.current = { onChange, onSubmit, disabled };
	const compartments = useRef({ language: new Compartment(), editable: new Compartment(), label: new Compartment() });
	const initial = useRef({ value, language, disabled, ariaLabel, autoFocus });

	useEffect(() => {
		if (!host.current) return;
		const config = initial.current;
		const c = compartments.current;
		const editor = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: config.value,
				extensions: [
					lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
					history(), indentOnInput(), indentUnit.of("    "), bracketMatching(), closeBrackets(),
					autocompletion({ override: [completeAnyWord] }), syntaxHighlighting(colors), editorTheme,
					c.language.of(languageExtension(config.language)),
					c.editable.of([EditorState.readOnly.of(config.disabled), EditorView.editable.of(!config.disabled)]),
					c.label.of(EditorView.contentAttributes.of({ "aria-label": config.ariaLabel, "aria-multiline": "true", spellcheck: "false", autocapitalize: "off", autocorrect: "off" })),
					keymap.of([
						{ key: "Mod-Enter", stopPropagation: true, run: () => { if (!callbacks.current.disabled) callbacks.current.onSubmit?.(); return true; } },
						...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab,
					]),
					EditorView.updateListener.of(update => {
						if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
					}),
				],
			}),
		});
		view.current = editor;
		if (config.autoFocus) editor.focus();
		return () => { editor.destroy(); view.current = null; };
	}, []);

	useEffect(() => {
		const editor = view.current;
		if (!editor || editor.state.doc.toString() === value) return;
		editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
	}, [value]);
	useEffect(() => { view.current?.dispatch({ effects: compartments.current.language.reconfigure(languageExtension(language)) }); }, [language]);
	useEffect(() => { view.current?.dispatch({ effects: compartments.current.editable.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) }); }, [disabled]);
	useEffect(() => { view.current?.dispatch({ effects: compartments.current.label.reconfigure(EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-multiline": "true", spellcheck: "false", autocapitalize: "off", autocorrect: "off" })) }); }, [ariaLabel]);

	return <div ref={host} data-testid="code-editor" data-language={language} className={cn("min-w-0 overflow-hidden rounded-lg border border-border/70 bg-background/60", className)} />;
}
