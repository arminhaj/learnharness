/** Pure stdio assessment, independent of how the program was built or run. */
import type { AssessmentResult, AssessmentCaseResult, StdioCheckSpec } from "./code-activity.ts";

/** One check case's execution outcome. `completed` means the process exited
 *  normally, so its output can be judged; anything else was not assessed. */
export interface StdioCaseExecution { caseId: string; completed: boolean; stdout: string; }

/** Ignore only final line endings; interior whitespace is part of the answer. */
export const normalizeStdout = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n+$/, "");

/** A case never executed, or executed abnormally, is `not_run`. The verdict is
 *  `failed` if any assessed case failed, else `not_run` if any case was not
 *  assessed, else `passed`. */
export function assessStdio(check: StdioCheckSpec, executions: readonly StdioCaseExecution[]): AssessmentResult {
	const byCase = new Map(executions.map(execution => [execution.caseId, execution]));
	const cases: AssessmentCaseResult[] = check.cases.map(item => {
		const execution = byCase.get(item.id);
		const status = !execution?.completed ? "not_run" : normalizeStdout(execution.stdout) === normalizeStdout(item.expectedStdout) ? "passed" : "failed";
		return { caseId: item.id, name: item.name, status };
	});
	const verdict = cases.some(item => item.status === "failed") ? "failed" : cases.some(item => item.status === "not_run") ? "not_run" : "passed";
	return { checkKind: check.kind, verdict, cases };
}
