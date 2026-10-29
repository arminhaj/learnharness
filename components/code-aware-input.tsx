"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { CodeIcon } from "lucide-react";
import { PathInput, type PathInputProps } from "@/components/path-input";
import { CodeEditor } from "@/components/code-editor";
import { fenceCode, readCodeFence } from "@/src/core";
import { cn } from "@/lib/utils";

/** The plain-text path editor keeps its own selection/history. Code gets a
 * dedicated editor; the parent still owns one portable answer string. */
export const CodeAwareInput = forwardRef<HTMLDivElement, PathInputProps & {
	onCodeSubmit: () => void;
	onCodeModeChange?: (enabled: boolean) => void;
}>(function CodeAwareInput({ value, onValueChange, onCodeSubmit, onCodeModeChange, className, ...props }, ref) {
	const [codeMode, setCodeMode] = useState(() => readCodeFence(value) !== null);
	const [language, setLanguage] = useState(() => readCodeFence(value)?.language ?? "cpp");
	const textRef = useRef<HTMLDivElement>(null);
	const editorRoot = useRef<HTMLDivElement>(null);
	useImperativeHandle(ref, () => (codeMode ? editorRoot.current?.querySelector<HTMLDivElement>(".cm-content") ?? editorRoot.current : textRef.current)!, [codeMode]);
	const parsed = readCodeFence(value);
	return (
		<div className="min-w-0 flex-1" data-testid="code-aware-input">
			<div className="flex items-center justify-between gap-2 px-2.5 pt-1">
				<button type="button" aria-pressed={codeMode} onClick={() => {
					if (codeMode) onValueChange(parsed?.source ?? value);
					else onValueChange(fenceCode(value, language));
					setCodeMode(!codeMode);
					onCodeModeChange?.(!codeMode);
				}} className={cn("flex items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-accent", codeMode ? "text-primary" : "text-muted-foreground")}>
					<CodeIcon className="size-3" />{codeMode ? "Code" : "Write code"}
				</button>
				{codeMode && <span className="flex items-center gap-2 text-xs text-muted-foreground">
					<select aria-label="Code language" value={parsed?.language ?? language} onChange={(event) => {
						setLanguage(event.target.value);
						onValueChange(fenceCode(parsed?.source ?? value, event.target.value));
					}} className="rounded bg-background p-1">
						<option value="cpp">C++</option><option value="text">Plain code</option>
					</select>
					<span>⌘/Ctrl+Enter sends</span>
					<a href="/code-demo" target="_blank" rel="noreferrer" className="underline underline-offset-2">Try C++ checks</a>
				</span>}
			</div>
			{codeMode ? <div ref={editorRoot} tabIndex={-1} onFocus={(event) => {
				if (event.target === event.currentTarget) editorRoot.current?.querySelector<HTMLElement>(".cm-content")?.focus();
			}} onKeyDown={(event) => {
				// CodeMirror owns Enter/Tab; the app still owns Escape.
				if (event.key === "Escape") props.onKeyDown?.(event);
			}}><CodeEditor value={parsed?.source ?? value} language={parsed?.language ?? language} onChange={(source) => onValueChange(fenceCode(source, parsed?.language ?? language))} onSubmit={onCodeSubmit} ariaLabel={props["aria-label"] ?? "Code answer"} autoFocus className="m-1 max-h-72 overflow-auto" /></div>
				: <PathInput {...props} ref={textRef} value={value} onValueChange={onValueChange} className={className} />}
		</div>
	);
});
