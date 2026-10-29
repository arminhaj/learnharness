import type { TurnInput } from "../core/input-events.ts";
import { formatCodeSubmission, type CodeRunResult } from "../core/code-workspace.ts";
import { getCodeRunForSubmission } from "./code-workspaces.ts";

/** Resolve an opaque check ID into server-owned evidence. The request's text
 * and any client-reported verdict never stand in for a real compiler result. */
export async function resolveCheckedCodeInput(
	chatId: string,
	input: TurnInput,
	readRun: (chatId: string, problemCallId: string, runId: string) => CodeRunResult | Promise<CodeRunResult> = getCodeRunForSubmission,
): Promise<TurnInput> {
	if (input.type !== "thinking" || !input.codeRunId) return input;
	const result = await readRun(chatId, input.problemCallId, input.codeRunId);
	return { ...input, text: formatCodeSubmission(result), codeResult: result };
}
