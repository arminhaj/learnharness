"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CODING_CONTEXT_BYTE_LIMIT, CODING_CONTEXT_FILE_LIMIT, CODING_GOAL_LIMIT, executableProfileFor, type CodeProfileReadiness, type CodingLanguageId, type CodingMode, type TeachingCodingStep } from "@/src/core";

export function NewCodingWorkspace({ languages, readiness = [], step }: {
	languages: readonly { id: CodingLanguageId; label: string }[];
	/** Serialized by the server page. Informational: generation and editing stay available. */
	readiness?: readonly CodeProfileReadiness[];
	step?: TeachingCodingStep & { title: string; goal: string; mode: CodingMode };
}) {
	const [mode, setMode] = useState<CodingMode>(step?.mode ?? "problem");
	const [language, setLanguage] = useState(languages[0]?.id ?? "cpp");
	const selectedReadiness = readiness.find(item => item.profileId === executableProfileFor(language)?.id);
	const [goal, setGoal] = useState(step?.goal ?? "");
	const [files, setFiles] = useState<File[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const inFlight = useRef<AbortController | null>(null);
	const router = useRouter();
	useEffect(() => () => inFlight.current?.abort(), []);

	async function generate(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (inFlight.current || !goal.trim()) return;
		const controller = new AbortController();
		inFlight.current = controller;
		setBusy(true);
		setError("");
		try {
			const selected = mode === "project" ? files : [];
			if (selected.length > CODING_CONTEXT_FILE_LIMIT || selected.reduce((total, file) => total + file.size, 0) > CODING_CONTEXT_BYTE_LIMIT) {
				throw new Error("Choose up to six text files totaling 48 KiB or less.");
			}
			const contextFiles = await Promise.all(selected.map(async file => ({ name: file.name, content: await file.text() })));
			const response = await fetch("/api/coding-sessions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode, language, goal, ...(contextFiles.length ? { contextFiles } : {}), ...(step ? { teachingStep: { chatId: step.chatId, nodeId: step.nodeId } } : {}) }),
				signal: controller.signal,
			});
			const result = await response.json() as { id?: string; error?: string };
			if (!response.ok || !result.id) throw new Error(result.error ?? "Could not generate the workspace.");
			router.push(`/code-demo/session/${encodeURIComponent(result.id)}`);
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not generate the workspace.");
		} finally {
			inFlight.current = null;
			setBusy(false);
		}
	}

	return (
		<form onSubmit={generate} className="max-w-2xl space-y-5">
			<div>
				<h2 className="font-title text-2xl">{step?.title ?? "What do you want to learn?"}</h2>
				<p className="mt-1 text-sm text-muted-foreground">{step ? "Create a runnable exercise for this Teaching step." : "Start from a learning goal. LearnHarness will generate starter code, a hint, a reference, and checks for the exercise."}</p>
			</div>
			<fieldset disabled={busy} className="space-y-5">
				<legend className="mb-2 text-sm font-medium">Workspace type</legend>
				<div className="grid gap-2 sm:grid-cols-2">
					<label className="flex cursor-pointer gap-2 rounded-lg border border-border p-3 has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5">
						<input type="radio" name="mode" value="problem" checked={mode === "problem"} onChange={() => { setMode("problem"); setFiles([]); }} />
						<span><span className="block text-sm font-medium">Problem</span><span className="text-xs text-muted-foreground">Practice an algorithm or prepare for an interview.</span></span>
					</label>
					<label className="flex cursor-pointer gap-2 rounded-lg border border-border p-3 has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5">
						<input type="radio" name="mode" value="project" checked={mode === "project"} onChange={() => setMode("project")} />
						<span><span className="block text-sm font-medium">Project</span><span className="text-xs text-muted-foreground">Learn a library or framework by implementing one feature.</span></span>
					</label>
				</div>
				<div className="space-y-2">
					<label htmlFor="coding-language" className="block text-sm font-medium">Language</label>
					<select id="coding-language" value={language} onChange={event => setLanguage(event.target.value as CodingLanguageId)} className="h-9 rounded-md border border-border bg-background px-3 text-sm">
						{languages.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
					</select>
					{selectedReadiness?.state === "unavailable" && <p role="status" className="text-xs text-muted-foreground">{selectedReadiness.message} You can still generate and edit this workspace; checks need it.</p>}
				</div>
				<div className="space-y-2">
					<label htmlFor="coding-goal" className="block text-sm font-medium">{mode === "problem" ? "Learning goal" : "Project and feature"}</label>
					<textarea
						id="coding-goal"
						value={goal}
						onChange={event => setGoal(event.target.value)}
						required
						maxLength={CODING_GOAL_LIMIT}
						rows={4}
						placeholder={mode === "problem"
							? "I’m preparing for a DSA interview. Give me a medium problem that teaches when to use a sliding window."
							: "I want to learn how a library API handles errors. Scaffold a small borrowing service and leave the error handling for me."}
						className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
				</div>
				{mode === "project" && (
					<div className="space-y-2">
						<label htmlFor="coding-context" className="block text-sm font-medium">Files from an existing codebase (optional)</label>
						<input
							id="coding-context"
							type="file"
							multiple
							aria-describedby="coding-context-help"
							onChange={event => setFiles(Array.from(event.target.files ?? []))}
							className="max-w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5"
						/>
						<p id="coding-context-help" className="text-xs text-muted-foreground">Choose up to six relevant text files, 48 KiB total. Their contents are sent to your configured model to create a separate exercise.</p>
						{files.length > 0 && <p className="break-words text-xs text-muted-foreground">Selected: {files.map(file => file.name).join(", ")}</p>}
					</div>
				)}
			</fieldset>
			{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
			<div className="flex flex-wrap items-center gap-3">
				<Button type="submit" disabled={busy || !goal.trim()}>{busy ? "Generating workspace…" : step ? "Generate exercise" : "Generate workspace"}</Button>
				{busy && <Button type="button" variant="outline" onClick={() => inFlight.current?.abort()}>Cancel</Button>}
			</div>
		</form>
	);
}
