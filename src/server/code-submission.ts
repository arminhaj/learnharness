import type { TurnInput } from "../core/input-events.ts";
import { formatCodeSubmission, type CodeRunResult } from "../core/code-workspace.ts";
import { fenceCode } from "../core/code-text.ts";
import { getCodeQuestionForSubmission, getCodeRunForSubmission } from "./code-workspaces.ts";

/** Resolve an opaque check ID into server-owned evidence. The request's text
 * and any client-reported verdict never stand in for a real compiler result. */
export async function resolveCheckedCodeInput(
	chatId: string,
	input: TurnInput,
	readRun: (chatId: string, problemCallId: string, runId: string) => CodeRunResult | Promise<CodeRunResult> = getCodeRunForSubmission,
	readQuestion: (chatId: string, callId: string) => string = getCodeQuestionForSubmission,
): Promise<TurnInput> {
	if ((input.type !== "thinking" && input.type !== "answer") || !input.codeRunId) return input;
	const callId = input.type === "thinking" ? input.problemCallId : input.toolCallId;
	const result = await readRun(chatId, callId, input.codeRunId);
	if (input.type === "thinking") return { ...input, text: formatCodeSubmission(result), codeResult: result };
	return canonicalTeachingAnswer(input, result, readQuestion(chatId, callId));
}

/** Final synchronous ownership/source check after an async boundary. The caller
 * appends the answer without yielding again, so an intervening edit or reposed
 * call cannot borrow an older compiler snapshot. */
export function revalidateCheckedCodeInput(
	chatId: string,
	input: TurnInput,
	readRun: (chatId: string, callId: string, runId: string) => CodeRunResult = getCodeRunForSubmission,
	readQuestion: (chatId: string, callId: string) => string = getCodeQuestionForSubmission,
): TurnInput {
	if ((input.type !== "thinking" && input.type !== "answer") || !input.codeRunId) return input;
	const callId = input.type === "thinking" ? input.problemCallId : input.toolCallId;
	const result = readRun(chatId, callId, input.codeRunId);
	if (input.type === "thinking") return { ...input, text: formatCodeSubmission(result), codeResult: result };
	return canonicalTeachingAnswer(input, result, readQuestion(chatId, callId));
}

function canonicalTeachingAnswer(input: Extract<TurnInput, { type: "answer" }>, result: CodeRunResult, questionText: string): TurnInput {
	return {
		...input,
		answer: {
			kind: "ask", tool: "ask_user_question", questionText, dontKnow: false, answers: [],
			text: fenceCode(result.source, result.language), codeResult: result,
			...(typeof input.answer.thinking === "string" ? { thinking: input.answer.thinking } : {}),
			...(typeof input.answer.readingThinking === "string" ? { readingThinking: input.answer.readingThinking } : {}),
			answeredAt: new Date().toISOString(),
		},
	};
}
