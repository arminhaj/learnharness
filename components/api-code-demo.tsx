"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { BookOpenIcon, CheckIcon, ChevronDownIcon, ExternalLinkIcon, FileCodeIcon, FilesIcon, FlaskConicalIcon, LoaderCircleIcon, PlayIcon, RefreshCwIcon, SaveIcon, TerminalIcon, XIcon } from "lucide-react";
import { CodeEditor } from "@/components/code-editor";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { API_DEMO_CODE_CONTEXT, API_DEMO_SCENARIOS, API_DEMO_TESTS, parseCompilerDiagnostics, type ApiDemoFile, type ApiDemoRun, type ApiDemoWorkspace, type CodeRunResult } from "@/src/core";

type Action = "load" | "save" | "run" | "check" | "open";
type Editor = "vscode" | "cursor" | "default";
type ResultTab = "run" | "check";

const runLabels: Record<ApiDemoRun["status"], string> = {
	completed: "Run finished",
	compilation_error: "Compilation failed",
	runtime_error: "Program stopped with an error",
	timeout: "Time limit reached",
	unavailable: "Compiler unavailable",
};
const checkLabels: Record<CodeRunResult["status"], string> = {
	passed: "All exercise checks passed",
	tests_failed: "Compiled · some checks failed",
	compilation_error: "Compilation failed",
	runtime_error: "Program stopped during checks",
	timeout: "Time limit reached",
	unavailable: "Compiler unavailable",
};

export function ApiCodeDemo() {
	const [workspace, setWorkspace] = useState<ApiDemoWorkspace | null>(null);
	const [source, setSource] = useState("");
	const [busy, setBusy] = useState<Action | null>("load");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [editor, setEditor] = useState<Editor>("vscode");
	const [scenario, setScenario] = useState("available");
	const [customInput, setCustomInput] = useState("dune 2 1");
	const [tab, setTab] = useState<ResultTab>("run");
	const [incoming, setIncoming] = useState<ApiDemoWorkspace | null>(null);
	const [backup, setBackup] = useState<string | null>(null);
	const generation = useRef(0);
	const busyRef = useRef(false);
	const state = useRef({ workspace, source, incoming });
	state.current = { workspace, source, incoming };
	const ids = useId();
	const stdin = scenario === "custom" ? `${customInput.trimEnd()}\n` : API_DEMO_SCENARIOS.find(item => item.id === scenario)!.stdin;
	const dirty = workspace !== null && source !== workspace.source;
	const locked = busy !== null;
	const canExecute = !locked && workspace !== null && incoming === null;
	const diagnostics = useMemo(() => {
		const run = workspace?.lastRun;
		const check = workspace?.lastCheck;
		const result = run && (!check || Date.parse(run.createdAt) > Date.parse(check.createdAt)) ? run : check;
		if (!workspace || !result || result.source !== source || result.revision !== workspace.revision) return [];
		const output = "compilerStderr" in result
			? `${result.compilerStdout}\n${result.compilerStderr}`
			: `${result.stdout}\n${result.stderr}`;
		return parseCompilerDiagnostics(output, "solution.cpp");
	}, [workspace, source]);

	const request = useCallback(async (action: Action, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ApiDemoWorkspace> => {
		const response = await fetch("/api/code-api-demo", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-LearnHarness-Code": "1" },
			body: JSON.stringify({ action, ...fields }),
			signal,
		});
		const body = await response.json().catch(() => null);
		if (!response.ok || !body) throw new Error(typeof body?.error === "string" ? body.error : "The API workspace could not be updated. Try again.");
		return body as ApiDemoWorkspace;
	}, []);

	const adopt = useCallback((next: ApiDemoWorkspace) => {
		setWorkspace(next);
		setSource(next.source);
		setIncoming(null);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		const version = ++generation.current;
		busyRef.current = true;
		request("load", {}, controller.signal)
			.then(next => { if (version === generation.current) adopt(next); })
			.catch(cause => { if (!controller.signal.aborted && version === generation.current) setError(cause instanceof Error ? cause.message : "Could not load the API workspace."); })
			.finally(() => { if (version === generation.current) { busyRef.current = false; setBusy(null); } });
		return () => { controller.abort(); generation.current++; };
	}, [request, adopt]);

	async function perform(action: Action) {
		if (busyRef.current || (action !== "load" && state.current.incoming)) return;
		if (action === "run" && !stdin.trim()) return;
		const current = state.current;
		const version = generation.current;
		busyRef.current = true;
		setBusy(action);
		setError(null);
		setNotice(null);
		try {
			if (action === "load") {
				const next = await request("load");
				if (version !== generation.current) return;
				if (current.workspace && current.source !== current.workspace.source && current.source !== next.source) setIncoming(next);
				else { adopt(next); setNotice("Saved file reloaded."); }
				return;
			}
			if (!current.workspace) return;
			if (current.source !== current.workspace.source) {
				const saved = await request("save", { source: current.source, expectedRevision: current.workspace.revision });
				if (version !== generation.current) return;
				adopt(saved);
			}
			if (action === "save") { setNotice("Saved solution.cpp."); return; }
			const next = await request(action, action === "open" ? { editor } : action === "run" ? { stdin } : {});
			if (version !== generation.current) return;
			adopt(next);
			if (action === "run" || action === "check") setTab(action);
			if (action === "open") setNotice("Opened the project in your editor. Save solution.cpp there, then run or check here.");
		} catch (cause) {
			if (version === generation.current) setError(cause instanceof Error ? cause.message : "The action failed. Your draft is still here.");
		} finally {
			if (version === generation.current) { busyRef.current = false; setBusy(null); }
		}
	}

	return (
		<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_280px]" data-testid="api-code-demo" aria-busy={locked}>
			<div className="min-w-0 space-y-4">
				<section className="rounded-xl border border-border bg-card p-3 sm:p-4" aria-label="Your C++ function">
					<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
						<div className="flex items-center gap-2 text-xs"><FileCodeIcon className="size-4 text-muted-foreground" /><h2 className="font-medium">solution.cpp</h2>{dirty && <span className="text-amber-700 dark:text-amber-300">Unsaved</span>}</div>
						<div className="flex flex-wrap items-center gap-1">
							<Button type="button" size="xs" variant="ghost" disabled={!canExecute || !dirty} onClick={() => void perform("save")}><SaveIcon />Save</Button>
							<Button type="button" size="xs" variant="ghost" disabled={locked} onClick={() => void perform("load")}><RefreshCwIcon />Reload saved file</Button>
						</div>
					</div>
					{workspace ? <CodeEditor value={source} onChange={setSource} language="cpp" completionContext={API_DEMO_CODE_CONTEXT} diagnostics={diagnostics} disabled={locked} onSubmit={() => void perform("check")} ariaLabel="API exercise solution" />
						: <div className="flex min-h-48 items-center justify-center gap-2 rounded-lg border border-border/70 bg-background/60 text-sm text-muted-foreground">{locked && <LoaderCircleIcon className="size-4 animate-spin" />}{locked ? "Preparing the API and starter files…" : "Workspace not loaded."}</div>}
					<p className="mt-2 text-[11px] text-muted-foreground">Vim: i to insert · Esc for Normal · ⌘/Ctrl+Enter checks the exercise.</p>
					<p className="mt-1 text-[11px] text-muted-foreground">API suggestions: Ctrl+Space · Tab accepts (Insert mode).</p>
					<p className="mt-1 text-[11px] text-muted-foreground">Errors are underlined; hover for an explanation or press F1 to jump to the next one. Run or check for full compiler feedback.</p>
					<div className="mt-3 flex flex-wrap items-center gap-2">
						<label htmlFor={`${ids}-editor`} className="sr-only">External editor</label>
						<select id={`${ids}-editor`} value={editor} onChange={event => setEditor(event.target.value as Editor)} disabled={locked} className="h-8 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"><option value="vscode">VS Code</option><option value="cursor">Cursor</option><option value="default">Default editor</option></select>
						<Button type="button" size="sm" variant="outline" disabled={!canExecute} onClick={() => void perform("open")}><ExternalLinkIcon />Open in editor</Button>
						<span className="text-[11px] text-muted-foreground">Headers and build files included.</span>
					</div>
				</section>

				{incoming && <div role="alert" className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
					<p>You have an unsaved draft. Choose which version to keep editing.</p>
					<div className="flex flex-wrap gap-2">
						<Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { setBackup(source); adopt(incoming); setNotice("Saved file loaded. Your previous draft can be restored below."); }}>Use saved file</Button>
						<Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { setWorkspace(incoming); setIncoming(null); setNotice("Draft kept. Saving, running, or checking will replace the saved file with this draft."); }}>Keep my draft</Button>
					</div>
				</div>}
				{backup !== null && <Button type="button" size="xs" variant="ghost" disabled={locked} onClick={() => { setSource(backup); setBackup(null); setNotice("Previous draft restored."); }}>Restore previous draft</Button>}
				{error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"><p>{error}</p><p className="mt-1 text-xs text-muted-foreground">Your draft is preserved. Reload to compare it with the saved file if edits conflict.</p></div>}
				{notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}

				<section aria-label="Run or check the exercise" className="rounded-xl border border-border bg-card p-3 sm:p-4">
					<div className="flex flex-wrap items-end gap-2">
						<div className="min-w-0 flex-1">
							<label htmlFor={`${ids}-scenario`} className="mb-1.5 block text-xs font-medium">Run with an input</label>
							<select id={`${ids}-scenario`} value={scenario} onChange={event => setScenario(event.target.value)} disabled={locked} className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50">{API_DEMO_SCENARIOS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="custom">Custom input</option></select>
						</div>
						<Button type="button" size="sm" variant="outline" className="h-9" disabled={!canExecute || !stdin.trim()} onClick={() => void perform("run")}>{busy === "run" ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}Run</Button>
						<Button type="button" size="sm" className="h-9" disabled={!canExecute} onClick={() => void perform("check")}>{busy === "check" ? <LoaderCircleIcon className="animate-spin" /> : <FlaskConicalIcon />}Check exercise</Button>
					</div>
					<div className="mt-3 grid gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
						<label htmlFor={`${ids}-stdin`} className="sr-only">Program input</label>
						<input id={`${ids}-stdin`} value={scenario === "custom" ? customInput : stdin.trimEnd()} onChange={event => setCustomInput(event.target.value)} readOnly={scenario !== "custom"} disabled={locked} maxLength={512} spellCheck={false} className="min-w-0 rounded-md border border-border/70 bg-background/60 px-2.5 py-2 font-mono text-xs disabled:opacity-50" />
						<p className="self-center text-[11px] text-muted-foreground">book_id · copies (0–10) · online (1/0)</p>
					</div>
					<p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">Run shows what your function does for this input. Check exercise compares all five cases. Neither action submits an answer or calls a tutor.</p>
				</section>

				<section className="overflow-hidden rounded-xl border border-border bg-card" aria-label="Execution results">
					<div className="flex gap-1 border-b border-border px-2 pt-2" role="tablist" aria-label="Result type">
						{(["run", "check"] as const).map(value => <button key={value} id={`${ids}-${value}-tab`} type="button" role="tab" aria-selected={tab === value} aria-controls={`${ids}-${value}-panel`} onClick={() => setTab(value)} className={cn("flex items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-xs", tab === value ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{value === "run" ? <TerminalIcon className="size-3.5" /> : <FlaskConicalIcon className="size-3.5" />}{value === "run" ? "Run output" : "Exercise checks"}</button>)}
					</div>
					<div role="tabpanel" id={`${ids}-run-panel`} aria-labelledby={`${ids}-run-tab`} hidden={tab !== "run"} className="p-3 sm:p-4">
						{workspace?.lastRun ? <RunResult run={workspace.lastRun} stale={workspace.lastRun.source !== source || workspace.lastRun.revision !== workspace.revision} /> : <div className="py-4 text-sm leading-relaxed text-muted-foreground">Choose an input and select Run to see the returned result, stock changes, and API calls.</div>}
					</div>
					<div role="tabpanel" id={`${ids}-check-panel`} aria-labelledby={`${ids}-check-tab`} hidden={tab !== "check"} className="p-3 sm:p-4">
						{workspace?.lastCheck ? <ExerciseCheck result={workspace.lastCheck} stale={workspace.lastCheck.source !== source || workspace.lastCheck.revision !== workspace.revision} /> : <div><p className="mb-3 text-sm text-muted-foreground">Five cases are ready to check your return value and changes to library stock.</p><ul className="space-y-2">{API_DEMO_TESTS.map(test => <li key={test.name} className="flex items-center gap-2 text-xs"><span className="size-1.5 rounded-full bg-border" />{test.name}<span className="ml-auto text-muted-foreground">Not checked</span></li>)}</ul></div>}
					</div>
				</section>
			</div>

			<aside className="min-w-0 space-y-4">
				<ApiReference />
				{workspace && <SupportingFiles files={workspace.files.filter(file => file.role !== "learner")} path={workspace.path} />}
			</aside>
		</div>
	);
}

function ApiReference() {
	return <section aria-label="Library API reference" className="rounded-xl border border-border bg-card p-4">
		<div className="mb-4 flex items-center gap-2"><BookOpenIcon className="size-4 text-muted-foreground" /><h2 className="text-sm font-medium">API reference</h2></div>
		<div className="space-y-4 text-xs leading-relaxed">
			<div><code className="font-medium">library.find_book(book_id)</code><p className="mt-1 text-muted-foreground">Returns <code>std::optional&lt;Book&gt;</code>. A missing book returns <code>std::nullopt</code>; looking up a book does not create a loan. This call may throw.</p></div>
			<div className="rounded-md bg-background/60 p-2.5"><code className="block text-[11px]">Book</code><p className="mt-1 text-[11px] text-muted-foreground">id: std::string<br />title: std::string<br />available_copies: int</p></div>
			<div><code className="font-medium">library.borrow(book_id)</code><p className="mt-1 text-muted-foreground">Returns <code>true</code> when a copy is borrowed: available copies decrease by one and loans increase by one. Returns <code>false</code> for a missing book or no stock; <code>false</code> does not distinguish those cases. This call may throw.</p></div>
			<div className="border-t border-border/70 pt-3"><code className="font-medium">ServiceUnavailable</code><p className="mt-1 text-muted-foreground">Both methods throw this exception when the service is offline. Handle it and return <code>BorrowResult::offline</code>.</p></div>
			<div className="border-t border-border/70 pt-3"><p className="mb-2 font-medium">Return a BorrowResult</p><dl className="space-y-2"><div><dt><code>BorrowResult::borrowed</code></dt><dd className="text-muted-foreground">A loan was created.</dd></div><div><dt><code>BorrowResult::unavailable</code></dt><dd className="text-muted-foreground">No copy can be borrowed.</dd></div><div><dt><code>BorrowResult::not_found</code></dt><dd className="text-muted-foreground">The book does not exist.</dd></div><div><dt><code>BorrowResult::offline</code></dt><dd className="text-muted-foreground">The service cannot respond.</dd></div></dl><p className="mt-2 text-muted-foreground">Use <code>::</code> for these enum values. End each return statement with <code>;</code>.</p></div>
			<p className="border-t border-border/70 pt-3 text-[11px] text-muted-foreground">The simulator knows one book: <code>dune</code>. The driver prints your return value, loan count, and remaining copies.</p>
		</div>
	</section>;
}

function SupportingFiles({ files, path }: { files: ApiDemoFile[]; path: string }) {
	const [selected, setSelected] = useState("library_api.hpp");
	const file = files.find(item => item.path === selected) ?? files[0];
	const id = useId();
	return <details className="group rounded-xl border border-border bg-card">
		<summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-xs"><FilesIcon className="size-4 text-muted-foreground" /><span className="flex-1">Generated project</span><span className="text-muted-foreground">{files.length + 1} files</span><ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" /></summary>
		<div className="space-y-3 border-t border-border px-4 py-3">
			<p className="text-[11px] leading-relaxed text-muted-foreground">Edit solution.cpp. The API, driver, and build files below are supplied for the exercise.</p>
			<label htmlFor={id} className="sr-only">View supporting file</label>
			<select id={id} value={file?.path ?? ""} onChange={event => setSelected(event.target.value)} className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs">{files.map(item => <option key={item.path} value={item.path}>{item.path}</option>)}</select>
			{file && <><p className="text-[11px] leading-relaxed text-muted-foreground">{file.description}</p><pre className="max-h-80 overflow-auto rounded-md bg-background/70 p-2.5 font-mono text-[11px] leading-relaxed" tabIndex={0} aria-label={`${file.path} source`}>{file.source}</pre></>}
			<div className="border-t border-border pt-3"><p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Workspace</p><code className="block select-all break-all text-[10px] leading-relaxed text-muted-foreground">{path}</code></div>
		</div>
	</details>;
}

function Output({ label, text, empty = "(empty)" }: { label: string; text: string; empty?: string }) {
	return <div className="min-w-0"><p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2.5 font-mono text-xs leading-relaxed">{text || empty}</pre></div>;
}

function PreviousVersion({ stale }: { stale: boolean }) {
	return stale ? <p className="mb-3 rounded-md bg-muted px-2.5 py-2 text-[11px] text-muted-foreground">Previous version — your code has changed since this result.</p> : null;
}

function CompilerOutput({ stdout, stderr, failed }: { stdout: string; stderr: string; failed: boolean }) {
	if (!stdout && !stderr) return null;
	return <details open={failed} className="rounded-md border border-border/70 px-3 py-2"><summary className="cursor-pointer text-xs text-muted-foreground">Compiler diagnostics</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{[stdout, stderr].filter(Boolean).join("\n")}</pre></details>;
}

export function ApiDemoRunResult({ run, stale = false }: { run: ApiDemoRun; stale?: boolean }) {
	return <RunResult run={run} stale={stale} />;
}

function RunResult({ run, stale }: { run: ApiDemoRun; stale: boolean }) {
	const compileFailed = run.status === "compilation_error" || run.status === "unavailable";
	return <div className="space-y-3" data-testid="api-run-result">
		<PreviousVersion stale={stale} />
		<div className="flex flex-wrap items-center gap-2 text-sm" role="status"><TerminalIcon className="size-4 text-muted-foreground" /><span className="font-medium">{runLabels[run.status]}</span>{run.status === "completed" && <span className="ml-auto text-[11px] text-muted-foreground">Observed output · not graded</span>}</div>
		<Output label="Input used" text={run.stdin} />
		{!compileFailed ? <div className="grid gap-3 sm:grid-cols-2"><Output label="Program output" text={run.stdout} /><Output label="API trace / error output" text={run.stderr} empty="No API calls or errors were logged." /></div> : <p className="text-xs text-muted-foreground">The program did not run. Resolve the compiler issue, then run again.</p>}
		<CompilerOutput stdout={run.compilerStdout} stderr={run.compilerStderr} failed={compileFailed} />
		<p className="text-[11px] text-muted-foreground">Use Check exercise to compare the behavior with the exercise requirements.</p>
	</div>;
}

function observedState(stdout: string) {
	const value = (key: string) => stdout.split(/\r?\n/).find(line => line.startsWith(`${key}: `))?.slice(key.length + 2) ?? "—";
	return { result: value("result"), loans: value("loans"), available: value("available") };
}

export function ApiDemoCheckResult({ result, stale = false }: { result: CodeRunResult; stale?: boolean }) {
	return <ExerciseCheck result={result} stale={stale} />;
}

function ExerciseCheck({ result, stale }: { result: CodeRunResult; stale: boolean }) {
	const passed = result.tests.filter(test => test.status === "passed").length;
	return <div className="space-y-3" data-testid="api-check-result">
		<PreviousVersion stale={stale} />
		<div className="flex flex-wrap items-center gap-2 text-sm" role="status">{result.status === "passed" ? <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" /> : <FlaskConicalIcon className="size-4 text-muted-foreground" />}<span className="font-medium">{checkLabels[result.status]}</span>{result.tests.length > 0 && <span className="ml-auto text-xs text-muted-foreground">{passed}/{result.tests.length} passed</span>}</div>
		{result.tests.length > 0 && <div className="overflow-hidden rounded-lg border border-border/70">{result.tests.map((test, index) => {
			const actual = observedState(test.stdout);
			return <details key={`${index}-${test.name}`} className="group border-b border-border/60 last:border-b-0">
				<summary className="cursor-pointer list-none px-3 py-2.5">
					<div className="flex items-center gap-2 text-xs">{test.status === "passed" ? <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <XIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />}<span className="flex-1">{test.name}</span><span className="text-[10px] text-muted-foreground">{test.status.replaceAll("_", " ")}</span><ChevronDownIcon className="size-3 transition-transform group-open:rotate-180" /></div>
					<p className="mt-1.5 pl-5 text-[10px] leading-relaxed text-muted-foreground">Actual: <code>{actual.result}</code> · loans {actual.loans} · copies left {actual.available}</p>
				</summary>
				<div className="grid gap-3 px-3 pb-3 sm:grid-cols-2"><Output label="Expected state" text={test.expectedStdout} /><Output label="Actual state" text={test.stdout} /><Output label="Input" text={test.stdin} /><Output label="API trace / error output" text={test.stderr} empty="No API calls or errors were logged." /></div>
			</details>;
		})}</div>}
		<CompilerOutput stdout={result.stdout} stderr={result.stderr} failed={result.status === "compilation_error" || result.status === "unavailable"} />
		<p className="text-[11px] leading-relaxed text-muted-foreground">Checks compare your return value, loan count, and remaining copies in the simulator. Passing them does not verify integration with a real library service.</p>
	</div>;
}
