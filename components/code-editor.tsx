"use client";

import { useEffect, useRef } from "react";
import { Compartment, EditorState, Prec, type Text } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { cpp } from "@codemirror/lang-cpp";
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completeAnyWord, completionStatus, moveCompletionSelection, startCompletion } from "@codemirror/autocomplete";
import { linter, lintKeymap, setDiagnostics, setDiagnosticsEffect, type Diagnostic } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import { cn } from "@/lib/utils";
import { findExerciseCodeDiagnostics, type ExerciseCodeContext, type ExerciseCodeDiagnostic } from "@/src/core";
import { createExerciseCompletionSource } from "@/components/code-completion";

export interface CodeEditorProps {
	value: string;
	onChange: (value: string) => void;
	language?: string;
	disabled?: boolean;
	onSubmit?: () => void;
	ariaLabel?: string;
	autoFocus?: boolean;
	className?: string;
	completionContext?: ExerciseCodeContext;
	diagnostics?: readonly ExerciseCodeDiagnostic[];
}

// The editor is a separate input surface: prose editing and path chips retain
// their own selection model. Language extensions can be added independently of
// compiler adapters; unsupported languages still get plain code editing.
const languageExtension = (language: string) => language === "cpp" ? cpp() : [];

function completionExtension(context?: ExerciseCodeContext) {
	const source = context ? createExerciseCompletionSource(context) : completeAnyWord;
	return autocompletion({
		defaultKeymap: false,
		override: [completion => !completion.state.readOnly && completion.view && getCM(completion.view)?.state.vim?.insertMode ? source(completion) : null],
	});
}

function editorDiagnostics(doc: Text, context: ExerciseCodeContext | undefined, compiler: readonly ExerciseCodeDiagnostic[]): Diagnostic[] {
	const diagnostics = [...(context ? findExerciseCodeDiagnostics(doc.toString(), context) : []), ...compiler];
	const seen = new Set<string>();
	return diagnostics.flatMap(diagnostic => {
		if (diagnostic.line < 1 || diagnostic.line > doc.lines || diagnostic.column < 1) return [];
		const line = doc.line(diagnostic.line);
		const from = Math.min(line.to, line.from + diagnostic.column - 1);
		const length = line.text.slice(from - line.from).match(/^\w+/)?.[0].length ?? 1;
		const to = Math.min(line.to, Math.max(from, diagnostic.endColumn ? line.from + diagnostic.endColumn - 1 : from + length));
		const key = `${from}:${to}:${diagnostic.severity}`;
		if (seen.has(key)) return [];
		seen.add(key);
		return [{ from, to, severity: diagnostic.severity, message: diagnostic.message, source: diagnostic.source }];
	});
}

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
	".cm-completionDetail": { color: "var(--muted-foreground)", marginLeft: "1em" },
	".cm-completionInfo": { padding: "8px 12px", maxWidth: "360px" },
	".cm-tooltip-lint": { maxWidth: "min(420px, 80vw)", fontFamily: "var(--font-geist), sans-serif", whiteSpace: "normal" },
	".cm-diagnostic": { padding: "6px 10px" },
	".cm-panels": { backgroundColor: "var(--muted)", color: "var(--foreground)" },
	".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
	".cm-vim-panel": { padding: "4px 10px", fontSize: "11px" },
});

export function CodeEditor({ value, onChange, language = "cpp", disabled = false, onSubmit, ariaLabel = "Code", autoFocus = false, className, completionContext, diagnostics }: CodeEditorProps) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const callbacks = useRef({ onChange, onSubmit, disabled });
	callbacks.current = { onChange, onSubmit, disabled };
	const assistance = useRef({ value, language, completionContext, diagnostics });
	assistance.current = { value, language, completionContext, diagnostics };
	const compartments = useRef({ language: new Compartment(), editable: new Compartment(), label: new Compartment(), completion: new Compartment() });
	const initial = useRef({ value, language, disabled, ariaLabel, autoFocus, completionContext });

	useEffect(() => {
		if (!host.current) return;
		const config = initial.current;
		const c = compartments.current;
		const diagnose = (doc: Text) => {
			const current = assistance.current;
			return editorDiagnostics(doc, current.language === "cpp" ? current.completionContext : undefined,
				doc.toString() === current.value ? current.diagnostics ?? [] : []);
		};
		const editor = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: config.value,
				extensions: [
					// Handle completion before Vim consumes Insert-mode keys. Escape
					// closes suggestions and still reaches Vim to enter Normal mode.
					Prec.highest(EditorView.domEventHandlers({ keydown: (event, editor) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
							event.stopPropagation();
							if (!callbacks.current.disabled) callbacks.current.onSubmit?.();
							return true;
						}
						if (event.key === "Escape" || (event.key === "[" && event.ctrlKey)) { closeCompletion(editor); return false; }
						if (callbacks.current.disabled || !getCM(editor)?.state.vim?.insertMode) return false;
						if (event.key === " " && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) return startCompletion(editor);
						if (completionStatus(editor.state) !== "active" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
						if (event.key === "Tab" || event.key === "Enter") return acceptCompletion(editor);
						if (event.key === "ArrowDown" || event.key === "ArrowUp") return moveCompletionSelection(event.key === "ArrowDown")(editor);
						if (event.key === "PageDown" || event.key === "PageUp") return moveCompletionSelection(event.key === "PageDown", "page")(editor);
						return false;
					} })),
					vim({ status: true }),
					lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
					history(), indentOnInput(), indentUnit.of("    "), bracketMatching(), closeBrackets(),
					c.completion.of(completionExtension(config.completionContext)), syntaxHighlighting(colors), editorTheme,
					linter(null),
					// Clear stale compiler positions in the same transaction as an
					// edit, and recompute conservative exercise hints on the new text.
					EditorState.transactionExtender.of(transaction => transaction.docChanged ? { effects: setDiagnosticsEffect.of(diagnose(transaction.newDoc)) } : null),
					c.language.of(languageExtension(config.language)),
					c.editable.of([EditorState.readOnly.of(config.disabled), EditorView.editable.of(!config.disabled)]),
					c.label.of(EditorView.contentAttributes.of({ "aria-label": config.ariaLabel, "aria-multiline": "true", spellcheck: "false", autocapitalize: "off", autocorrect: "off" })),
					keymap.of([
						...closeBracketsKeymap, ...lintKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab,
					]),
					EditorView.updateListener.of(update => {
						if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
					}),
				],
			}),
		});
		editor.dispatch(setDiagnostics(editor.state, diagnose(editor.state.doc)));
		// Handle keys in CodeMirror first, then stop them before any React or
		// document-level abort, dictation, or navigation shortcut sees them.
		const stopAppShortcuts = (event: KeyboardEvent) => event.stopPropagation();
		editor.dom.addEventListener("keydown", stopAppShortcuts);
		view.current = editor;
		if (config.autoFocus) editor.focus();
		return () => { editor.dom.removeEventListener("keydown", stopAppShortcuts); editor.destroy(); view.current = null; };
	}, []);

	useEffect(() => {
		const editor = view.current;
		if (!editor || editor.state.doc.toString() === value) return;
		editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
	}, [value]);
	useEffect(() => { view.current?.dispatch({ effects: compartments.current.language.reconfigure(languageExtension(language)) }); }, [language]);
	useEffect(() => { view.current?.dispatch({ effects: compartments.current.completion.reconfigure(completionExtension(completionContext)) }); }, [completionContext]);
	useEffect(() => {
		const editor = view.current;
		if (editor) editor.dispatch(setDiagnostics(editor.state, editorDiagnostics(editor.state.doc, language === "cpp" ? completionContext : undefined,
			editor.state.doc.toString() === value ? diagnostics ?? [] : [])));
	}, [completionContext, diagnostics, language, value]);
	useEffect(() => {
		const editor = view.current;
		if (!editor) return;
		if (disabled) closeCompletion(editor);
		editor.dispatch({ effects: compartments.current.editable.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) });
	}, [disabled]);
	useEffect(() => { view.current?.dispatch({ effects: compartments.current.label.reconfigure(EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-multiline": "true", spellcheck: "false", autocapitalize: "off", autocorrect: "off" })) }); }, [ariaLabel]);

	return <div ref={host} data-testid="code-editor" data-language={language} className={cn("min-w-0 overflow-hidden rounded-lg border border-border/70 bg-background/60", className)} />;
}
