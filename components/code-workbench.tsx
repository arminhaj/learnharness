"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, Code2Icon, ExternalLinkIcon, LoaderCircleIcon, PlayIcon, RefreshCwIcon, SaveIcon, XIcon } from "lucide-react";
import { CodeEditor } from "@/components/code-editor";
import { Button } from "@/components/ui/button";
import type { CodeRunResult, CodeWorkspaceView } from "@/src/core";

type Operation = "load" | "save" | "check" | "open";
type Editor = "vscode" | "cursor" | "default";

const resultLabels: Record<CodeRunResult["status"], string> = {
	passed: "All tests passed",
	tests_failed: "Compiled · some tests failed",
	compilation_error: "Compilation failed",
	runtime_error: "Program stopped with an error",
	timeout: "Time limit reached",
	unavailable: "Compiler unavailable",
};

/** Render stored evidence, including failed attempts, without equating a
 * successful build with a correct answer. Also used by the session transcript. */
export function CodeCheckResults({ result, stale = false }: { result: CodeRunResult; stale?: boolean }) {
	const passed = result.tests.filter(test => test.status === "passed").length;
	const successful = result.status === "passed";
	return (
		<section aria-label="Code check results" className="min-w-0 rounded-lg border border-border/70 bg-background/40" data-testid="code-check-results">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5" role="status">
				{successful ? <CheckIcon aria-hidden className="size-4 text-emerald-600 dark:text-emerald-400" /> : <XIcon aria-hidden className="size-4 text-amber-600 dark:text-amber-400" />}
				<span className="text-sm font-medium">{resultLabels[result.status]}</span>
				{stale && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Previous version</span>}
				{result.tests.length > 0 && <span className="ml-auto text-xs text-muted-foreground">{passed}/{result.tests.length} tests</span>}
			</div>
			{stale && <p className="px-3 pb-2 text-xs text-muted-foreground">The code has changed since this check. Check again to test the current version.</p>}
			{result.tests.length > 0 && (
				<div className="border-t border-border/60">
					{result.tests.map((test, index) => (
						<details key={`${index}-${test.name}`} className="group border-b border-border/40 last:border-b-0">
							<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs hover:bg-accent/40">
								{test.status === "passed" ? <CheckIcon aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <XIcon aria-hidden className="size-3.5 text-amber-600 dark:text-amber-400" />}
								<span className="min-w-0 flex-1 break-words">{test.name}</span>
								<span className="text-muted-foreground">{test.status.replaceAll("_", " ")}</span>
								<ChevronDownIcon aria-hidden className="size-3 transition-transform group-open:rotate-180" />
							</summary>
							<div className="grid gap-2 px-3 pb-3 sm:grid-cols-3">
								<Output label="Input" text={test.stdin} />
								<Output label="Expected output" text={test.expectedStdout} />
								<Output label="Actual output" text={test.stdout} />
								{test.stderr && <div className="sm:col-span-3"><Output label="Error output" text={test.stderr} /></div>}
							</div>
						</details>
					))}
				</div>
			)}
			{(result.stdout || result.stderr) && (
				<details open={result.status === "compilation_error" || result.status === "unavailable"} className="border-t border-border/60 px-3 py-2">
					<summary className="cursor-pointer text-xs text-muted-foreground">Compiler output</summary>
					<pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{[result.stdout, result.stderr].filter(Boolean).join("\n")}</pre>
				</details>
			)}
			<div className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">{successful ? "These test cases pass. Your tutor will review the solution and reasoning." : "Use the result to revise your code, or submit it for help."}</div>
		</section>
	);
}

function Output({ label, text }: { label: string; text: string }) {
	return <div className="min-w-0"><div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div><pre className="max-h-32 overflow-auto rounded bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap break-words">{text || "(empty)"}</pre></div>;
}

export interface CodeWorkbenchProps {
	chatId: string;
	problemCallId: string;
	onSubmit?: (runId: string) => void | Promise<void>;
	disabled?: boolean;
}

export function CodeWorkbench({ chatId, problemCallId, onSubmit, disabled = false }: CodeWorkbenchProps) {
	const [workspace, setWorkspace] = useState<CodeWorkspaceView | null>(null);
	const [source, setSource] = useState("");
	const [busy, setBusy] = useState<Operation | "submit" | null>("load");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [editor, setEditor] = useState<Editor>("vscode");
	const [incoming, setIncoming] = useState<CodeWorkspaceView | null>(null);
	const [backup, setBackup] = useState<string | null>(null);
	const generation = useRef(0);
	const busyRef = useRef(false);
	const state = useRef({ workspace, source, disabled, onSubmit, incoming });
	state.current = { workspace, source, disabled, onSubmit, incoming };
	const editorId = useId();
	const dirty = workspace !== null && source !== workspace.source;
	const locked = disabled || busy !== null;

	const request = useCallback(async (action: Operation, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<CodeWorkspaceView> => {
		const response = await fetch("/api/code-workspaces", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-LearnHarness-Code": "1" },
			body: JSON.stringify({ action, chatId, problemCallId, ...fields }),
			signal,
		});
		const body = await response.json();
		if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The code workspace could not be updated.");
		return body as CodeWorkspaceView;
	}, [chatId, problemCallId]);

	const adopt = useCallback((next: CodeWorkspaceView) => {
		setWorkspace(next);
		setSource(next.source);
		setIncoming(null);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		const version = ++generation.current;
		busyRef.current = true;
		setBusy("load");
		setWorkspace(null);
		setSource("");
		setError(null);
		setIncoming(null);
		setBackup(null);
		setNotice(null);
		request("load", {}, controller.signal)
			.then(next => { if (generation.current === version) adopt(next); })
			.catch(cause => { if (!controller.signal.aborted && generation.current === version) setError(cause instanceof Error ? cause.message : "Could not load the code workspace."); })
			.finally(() => { if (generation.current === version) { busyRef.current = false; setBusy(null); } });
		return () => { controller.abort(); generation.current++; };
	}, [request, adopt]);

	async function perform(action: Operation, submit = false) {
		if (busyRef.current || state.current.disabled) return;
		if (action !== "load" && state.current.incoming) return;
		busyRef.current = true;
		const version = generation.current;
		const current = state.current;
		setBusy(action);
		setError(null);
		setNotice(null);
		try {
			if (action === "load") {
				const next = await request("load");
				if (version !== generation.current) return;
				if (current.workspace && current.source !== current.workspace.source && current.source !== next.source) {
					setIncoming(next);
				} else {
					adopt(next);
					setNotice("Saved file reloaded.");
				}
				return;
			}
			if (!current.workspace) return;
			let saved = current.workspace;
			if (current.source !== current.workspace.source) {
				saved = await request("save", { source: current.source, expectedRevision: current.workspace.revision });
				if (version !== generation.current) return;
				adopt(saved);
			}
			if (action === "save") {
				setNotice("Saved to the workspace.");
				return;
			}
			const next = await request(action, action === "open" ? { editor } : {});
			if (version !== generation.current) return;
			adopt(next);
			if (action === "open") setNotice("Opened the saved file. Save your changes in the editor, then check here.");
			if (submit && next.lastRun && current.onSubmit) {
				setBusy("submit");
				await current.onSubmit(next.lastRun.id);
				if (version === generation.current) setNotice("Code and check results submitted.");
			}
		} catch (cause) {
			if (version === generation.current) setError(cause instanceof Error ? cause.message : "The code action failed. Your draft is still here.");
		} finally {
			if (version === generation.current) { busyRef.current = false; setBusy(null); }
		}
	}

	return (
		<div className="space-y-3" data-testid="code-workbench" aria-busy={busy !== null}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2 text-xs">
					<Code2Icon aria-hidden className="size-4 text-muted-foreground" />
					<span className="font-mono">{workspace?.filename ?? "Code workspace"}</span>
					<span className="text-muted-foreground">{workspace?.language === "cpp" ? "C++20" : workspace?.language}</span>
					{dirty && <span className="text-amber-700 dark:text-amber-300">Unsaved</span>}
				</div>
				<div className="flex items-center gap-1.5">
					<Button type="button" size="xs" variant="ghost" disabled={locked || !dirty || !!incoming} onClick={() => void perform("save")}><SaveIcon />Save</Button>
					<Button type="button" size="xs" variant="ghost" disabled={locked} onClick={() => void perform("load")}><RefreshCwIcon />Reload saved file</Button>
				</div>
			</div>

			{workspace ? (
				<CodeEditor value={source} onChange={setSource} language={workspace.language} disabled={locked} onSubmit={() => void perform("check", Boolean(onSubmit))} ariaLabel="Solution code" />
			) : (
				<div className="flex min-h-40 items-center justify-center gap-2 rounded-lg border border-border/70 bg-background/60 text-sm text-muted-foreground">
					{busy && <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />}{busy ? "Preparing starter files…" : "Workspace not loaded."}
				</div>
			)}

			{incoming && (
				<div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm" role="alert">
					<p>You have an unsaved draft. Choose which version to keep editing.</p>
					<div className="flex flex-wrap gap-2">
						<Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { setBackup(source); adopt(incoming); setNotice("Saved file loaded. Your previous draft can be restored below."); }}>Use saved file</Button>
						<Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { setWorkspace(incoming); setIncoming(null); setNotice("Draft kept. Saving or checking will replace the saved file with this draft."); }}>Keep my draft</Button>
					</div>
				</div>
			)}
			{backup !== null && <Button type="button" size="xs" variant="ghost" disabled={locked} onClick={() => { setSource(backup); setBackup(null); setNotice("Previous draft restored. Save it to update the file."); }}>Restore previous draft</Button>}
			{error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"><p>{error}</p><p className="mt-1 text-xs text-muted-foreground">Your current draft is unchanged. Reload the saved file to resolve conflicting edits.</p></div>}
			{notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}

			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor={editorId} className="sr-only">External editor</label>
				<select id={editorId} value={editor} onChange={event => setEditor(event.target.value as Editor)} disabled={locked} className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50">
					<option value="vscode">VS Code</option>
					<option value="cursor">Cursor</option>
					<option value="default">Default editor</option>
				</select>
				<Button type="button" variant="outline" size="sm" disabled={locked || !workspace || !!incoming} onClick={() => void perform("open")}><ExternalLinkIcon />Open in editor</Button>
				<div className="ml-auto flex gap-2">
					<Button type="button" variant={onSubmit ? "outline" : "default"} size="sm" disabled={locked || !workspace || !!incoming} onClick={() => void perform("check")}>{busy === "check" ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}Check</Button>
					{onSubmit && <Button type="button" size="sm" disabled={locked || !workspace || !!incoming} onClick={() => void perform("check", true)}>{busy === "submit" && <LoaderCircleIcon className="animate-spin" />}Check &amp; submit</Button>}
				</div>
			</div>
			<p className="text-[11px] leading-relaxed text-muted-foreground">Vim: i to insert · Esc for Normal · ⌘/Ctrl+Enter {onSubmit ? "checks and submits" : "checks"}. Checks run on this computer using your installed compiler.</p>
			{workspace?.path && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Workspace file</summary><code className="mt-1 block select-all break-all rounded bg-muted/50 px-2 py-1.5">{workspace.path}</code></details>}
			{workspace?.lastRun && <CodeCheckResults result={workspace.lastRun} stale={workspace.lastRun.source !== source} />}
			{workspace && !workspace.lastRun && <p className="text-xs text-muted-foreground">{workspace.tests.length} test cases ready. Check your code to see compiler and test results.</p>}
		</div>
	);
}
