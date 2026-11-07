/** A deliberate teaching pause is distinct from a text-only model stop. */
export const TEACHING_PAUSE_TOOL = "pause_teaching";

export function teachingPauseReason(message: unknown): "learner_request" | "waiting_for_job" | null {
	const m = message as { role?: string; toolName?: string; isError?: boolean; details?: { reason?: string } } | undefined;
	if (m?.role !== "toolResult" || m.toolName !== TEACHING_PAUSE_TOOL || m.isError) return null;
	return m.details?.reason === "learner_request" || m.details?.reason === "waiting_for_job" ? m.details.reason : null;
}

/** A later learner input releases the pause; automatic delivery cannot. */
export function teachingPausedByLearner(messages: readonly unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; toolName?: string; details?: { answeredAt?: string } };
		if (m.role === "user" || (m.role === "toolResult" && m.details?.answeredAt)) return false;
		const reason = teachingPauseReason(m);
		if (reason) return reason === "learner_request";
	}
	return false;
}
