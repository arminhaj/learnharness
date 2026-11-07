import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JobStore } from "../../core/ports.ts";
import { TEACHING_PAUSE_TOOL } from "../../core/teaching-flow.ts";
import { invalidInputResult } from "../tool-execute.ts";

const input = Type.Object({
	reason: Type.Union([Type.Literal("learner_request"), Type.Literal("waiting_for_job")]),
	explanation: Type.String({ minLength: 1, description: "The learner's request to pause, or the specific result needed before continuing." }),
	jobId: Type.Optional(Type.String({ minLength: 1 })),
});

export function teachingPauseTool(ctx: { chatId: string; jobStore: JobStore }): AgentTool<typeof input> {
	return {
		name: TEACHING_PAUSE_TOOL,
		label: "Pause teaching",
		description: "Pause only when the learner explicitly asks to stop, pause, or receive just an answer without continuing (learner_request), or when a specific running background job must finish before teaching can proceed (waiting_for_job, requires jobId). Explain the pause to the learner in prose before calling this tool. Feedback, an incorrect answer, and a completed individual step are not reasons to pause. If you need an answer or missing material from the learner, use a question tool instead. This does not complete the lesson or its plan steps.",
		parameters: input,
		executionMode: "sequential",
		execute: async (_id, args) => {
			if (!args.explanation.trim()) return invalidInputResult(TEACHING_PAUSE_TOOL, ["Explain why teaching must pause."]);
			if (args.reason === "waiting_for_job") {
				const job = args.jobId ? ctx.jobStore.getJob(args.jobId) : null;
				if (!job || job.chatId !== ctx.chatId || job.status !== "running") {
					return invalidInputResult(TEACHING_PAUSE_TOOL, ["jobId must name a currently running job in this lesson. If it has finished, use its result or continue teaching."]);
				}
			}
			return {
				content: [{ type: "text", text: args.reason === "learner_request" ? "Teaching paused at the learner's request. Resume on their next input." : "Teaching is waiting for the specified background job; its delivery will resume the lesson." }],
				details: args,
				terminate: true,
			};
		},
	};
}
