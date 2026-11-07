import type { AgentTurnContext, AgentTurnDecision } from "@earendil-works/pi-agent-core";
import type { PlanToolContext } from "./tools/plan.ts";
import { lessonProgress } from "../core/lesson-progress.ts";
import { sessionLessonComplete } from "../core/session-sections.ts";
import { teachingPauseReason } from "../core/teaching-flow.ts";
import { phaseAt3Lh } from "../core/phases.ts";
import type { LhMessage } from "../core/native-messages.ts";

export const TEACHING_CONTINUATION_REMINDER = "[LearnHarness teaching flow] Your feedback has already been shown. This lesson is unfinished and no learner question or deliberate pause is pending. Continue from the feedback without repeating it: repair the remaining gap or take the next useful teaching step, then use the appropriate question tool when learner input is needed. Respect the selected teaching profile; do not invent an extra check for already-demonstrated understanding. Record genuinely completed plan steps. If the learner explicitly requested a pause, explain it and call pause_teaching. If a running background job is essential, explain that wait and call pause_teaching with its jobId. Do not mark work complete just to end the turn.";

export function createTeachingContinuation(ctx: PlanToolContext) {
	let consecutiveStops = 0;
	return {
		get reminder() { return consecutiveStops > 0 ? TEACHING_CONTINUATION_REMINDER : undefined; },
		finish(turn: AgentTurnContext, signal?: AbortSignal): AgentTurnDecision | undefined {
			if (signal?.aborted || turn.message.stopReason === "aborted" || turn.message.stopReason === "error") return;
			if (turn.toolResults.some(result => teachingPauseReason(result))) return { action: "end" };
			if (turn.message.content.some(part => part.type === "toolCall")) {
				consecutiveStops = 0;
				return;
			}
			// Only recover a clean text stop. Truncation and transport failures
			// retain their existing error/retry behavior.
			if (turn.message.stopReason !== "stop") return;
			if (!turn.message.content.some(part => part.type === "text" && part.text.trim())) return;
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record || record.archivedAt) return;
			const progress = lessonProgress(record.tree);
			if (sessionLessonComplete({ lessonCompleted: record.lessonCompleted, lessonCompletion: { total: progress.total, completed: progress.count } })) return;
			// A pre-plan conversation is outside the feedback safeguard.
			if (progress.total === 0) return;
			// Preserve the initial plan-approval conversation. Include the saved
			// record so compaction cannot erase the evidence that teaching began.
			if (phaseAt3Lh([...record.messages, ...turn.context.messages] as LhMessage[], undefined, "plan") !== "teach") return;
			if (++consecutiveStops > 2) {
				throw new Error("The tutor could not provide the next teaching activity after automatic retries. Your feedback is saved. Retry to continue the unfinished lesson.");
			}
			return { action: "continue" };
		},
	};
}
