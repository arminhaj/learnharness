"use client";

import { useContext, useRef, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import { JobsContext } from "@/components/jobs-context";
import { latestJobAttempt, type JobRecord } from "@/src/core";

/** A successful retry response remains authoritative until the jobs feed
 * contains that attempt. This prevents stale failure cards retrying twice. */
export function useDemoRetryAttempt(initialJob: JobRecord | null) {
	const actions = useContext(ChatActionsContext);
	const jobs = useContext(JobsContext);
	const [accepted, setAccepted] = useState<JobRecord | null>(null);
	const acceptedRef = useRef<JobRecord | null>(null);
	const [requesting, setRequesting] = useState(false);
	const requestingRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const select = (retained: JobRecord | null): JobRecord | null => {
		if (!initialJob) return null;
		const candidates = jobs.filter(job => job.chatId === initialJob.chatId && job.toolCallId === initialJob.toolCallId);
		for (const job of [initialJob, retained]) {
			if (job && job.chatId === initialJob.chatId && job.toolCallId === initialJob.toolCallId && !candidates.some(candidate => candidate.id === job.id)) candidates.push(job);
		}
		return latestJobAttempt(candidates, initialJob.toolCallId) ?? null;
	};
	const job = select(accepted);
	const canRetry = job?.kind === "demo" && job.status === "error" && actions?.chatId === job.chatId;
	const retry = async () => {
		const target = select(acceptedRef.current);
		if (requestingRef.current || target?.kind !== "demo" || target.status !== "error" || actions?.chatId !== target.chatId) return;
		requestingRef.current = true;
		setRequesting(true);
		setError(null);
		try {
			const response = await fetch(`/api/jobs/${encodeURIComponent(target.id)}/retry`, {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: target.chatId }),
			});
			const body = await response.json().catch(() => null) as { job?: JobRecord; error?: string } | null;
			if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "The demo could not be retried. Try again.");
			const next = body?.job;
			if (!next || typeof next.id !== "string" || !next.id || typeof next.createdAt !== "string" || next.chatId !== target.chatId || next.kind !== "demo" || next.toolCallId !== target.toolCallId ||
				!["running", "done", "error"].includes(next.status)) throw new Error("The retry response was incomplete. Refresh the session to check its status.");
			acceptedRef.current = next;
			setAccepted(next);
			actions.refreshJobs?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "The demo could not be retried. Try again.");
		} finally {
			requestingRef.current = false;
			setRequesting(false);
		}
	};
	return { job, canRetry, requesting, error, retry };
}

export function RetryDemoButton({ retry }: { retry: ReturnType<typeof useDemoRetryAttempt> }) {
	if (!retry.canRetry) return null;
	return <span className="inline-flex flex-wrap items-center gap-2">
		<button type="button" data-testid="retry-demo-button" disabled={retry.requesting}
			onClick={() => { void retry.retry(); }}
			className="rounded-sm border border-border bg-card px-2 py-0.5 font-ui normal-case tracking-normal text-foreground transition-colors hover:border-muted-foreground/50 disabled:opacity-50">
			{retry.requesting ? "Retrying…" : "Retry demo"}
		</button>
		{retry.error && <span role="alert" className="text-xs text-destructive">{retry.error}</span>}
	</span>;
}
