/** Browser-safe presentation helpers over a stored CodeRunResult. Historical
 *  results have no detail envelope and are C++ runs. */
import { CODE_LEARNER_RESOURCE_ID } from "./code-activity.ts";
import { executableProfileFor, findCodeProfile, type CodeProfileLabels } from "./code-language-catalog.ts";
import { parseCompilerDiagnostics, type ExerciseCodeDiagnostic } from "./code-diagnostics.ts";
import type { CodeRunResult } from "./code-workspace.ts";

const fallbackLabels: CodeProfileLabels = { buildPassed: "Built", buildFailed: "Build failed", buildOutput: "Build output", toolchainUnavailable: "Toolchain unavailable" };

export function codeResultLabels(result: Pick<CodeRunResult, "language" | "detail">): CodeProfileLabels {
	const profile = (result.detail ? findCodeProfile(result.detail.profile.id) : undefined) ?? executableProfileFor(result.language);
	return profile?.labels ?? fallbackLabels;
}

/** Headline for a stored result, phase-aware through the profile's labels. */
export function codeStatusLabel(result: Pick<CodeRunResult, "language" | "detail" | "status">): string {
	const labels = codeResultLabels(result);
	switch (result.status) {
		case "passed": return "All tests passed";
		case "tests_failed": return `${labels.buildPassed} · some tests failed`;
		case "compilation_error":
		case "preparation_error": return labels.buildFailed;
		case "runtime_error": return "Program stopped with an error";
		case "timeout": return "Time limit reached";
		case "unavailable": return labels.toolchainUnavailable;
	}
}

/** Learner-file diagnostics from a result. Evidence diagnostics are matched by
 *  resource; support-file problems are never attributed to the learner file.
 *  Results without evidence fall back to parsing the compiler text. */
export function learnerDiagnostics(result: CodeRunResult, filename: string): ExerciseCodeDiagnostic[] {
	if (result.detail) {
		return result.detail.evidence.diagnostics
			.filter(diagnostic => diagnostic.resourceId === CODE_LEARNER_RESOURCE_ID && diagnostic.range && diagnostic.severity !== "info")
			.map(diagnostic => ({
				line: diagnostic.range!.line,
				column: diagnostic.range!.column ?? 1,
				...(diagnostic.range!.column === undefined ? { lineOnly: true } : {}),
				...(diagnostic.range!.endColumn !== undefined && (diagnostic.range!.endLine === undefined || diagnostic.range!.endLine === diagnostic.range!.line) ? { endColumn: diagnostic.range!.endColumn } : {}),
				severity: diagnostic.severity as "error" | "warning",
				message: diagnostic.message,
				source: diagnostic.source,
			}));
	}
	return parseCompilerDiagnostics(`${result.stdout}\n${result.stderr}`, filename);
}
