import type { DemoResult, JobRecord, LhViewMessage, VisualResult } from "@/src/core";
import { hasJobRetry } from "@/src/core";

/** Display completed figures and verified demos independently of teacher delivery.
 * Failed retries also stay reachable if the original dispatch was compacted.
 * These view-only entries never enter session state, the saved transcript, or
 * the model's context. The real delivery replaces them by the same stable id.
 */
export function withCompletedVisuals(
	messages: LhViewMessage[],
	jobs: readonly JobRecord[],
	chatId: string,
): LhViewMessage[] {
	// Keep failed attempts in saved history, but replace their artifact in
	// the lesson as soon as the learner starts a retry of that dispatch.
	const replaced = new Set(jobs.filter(job => job.chatId === chatId && job.kind === "demo" && hasJobRetry(job, jobs))
		.map(job => `steer_${job.id}`));
	const visible = replaced.size ? messages.filter(message => !replaced.has(message.id)) : messages;
	const visibleIds = new Set(visible.map(message => message.id));
	const calls = new Set(messages.flatMap(message => message.parts.flatMap(part =>
		part.type === "tool-visual" || part.type === "tool-demo" ? [`${part.type}:${part.toolCallId}`] : [])));
	const artifacts: LhViewMessage[] = [];
	for (const job of [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
		const id = `steer_${job.id}`;
		const result = job.result as VisualResult | DemoResult | undefined;
		const retryFailure = job.kind === "demo" && !!job.retryOf && job.status === "error";
		if (job.chatId !== chatId || (job.kind !== "visual" && job.kind !== "demo") || (job.status !== "done" && !retryFailure) ||
			job.delivery?.kind !== "result" || job.delivery.status === "superseded" || replaced.has(id) || visibleIds.has(id)) continue;
		if (job.kind === "visual") {
			const figure = result as VisualResult | undefined;
			if (typeof figure?.svg !== "string" || !figure.svg) continue;
		} else {
			const demo = result as DemoResult | undefined;
			if (demo?.tested !== true || typeof demo.html !== "string" || (retryFailure ? demo.html !== "" : !demo.html.trim()) ||
				typeof demo.title !== "string" || !demo.title.trim()) continue;
		}
		// A delivery can reach the jobs feed before its transcript marker. Keep
		// the artifact visible in that gap, but do not revive compacted history.
		if (job.delivery.status === "delivered" && !calls.has(`tool-${job.kind}:${job.toolCallId}`)) continue;
		visibleIds.add(id);
		artifacts.push({
			id,
			role: "user",
			metadata: { subagentResult: { jobId: job.id, kind: job.kind, toolCallId: job.toolCallId } },
			parts: [{ type: "data-subagent-artifact", id: `sa_${id}`, data: { kind: job.kind, result, ui: job.ui } }],
		});
	}
	return artifacts.length ? [...visible, ...artifacts] : visible;
}
