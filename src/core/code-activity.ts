/** Browser-safe contracts for a normalized code activity and its evidence.
 *  Types and pure normalization only: no Node APIs, providers, or runtime probes. */
import { executableProfileFor, type CodeCheckKind } from "./code-language-catalog.ts";
import type { CodeExercise } from "./code-workspace.ts";

export type CodeResourceRole = "learner" | "support";

export interface CodeResource {
	id: string;
	/** Validated relative path inside the workspace. */
	path: string;
	/** Language ID for non-source resources; source resources use the profile language. */
	language?: string;
	content: string;
	role: CodeResourceRole;
	editable: boolean;
}

export interface CodeProgramTarget {
	kind: "program";
	entryResourceId: string;
}

export interface StdioCheckCase { id: string; name: string; stdin: string; expectedStdout: string; }
export interface StdioCheckSpec { kind: "stdio"; cases: StdioCheckCase[]; }
/** Discriminated by `kind`; stdio is the only kind today. */
export type CodeCheckSpec = StdioCheckSpec;

export interface CodeActivitySpec {
	schemaVersion: 2;
	profile: { id: string; version: number };
	resources: CodeResource[];
	target: CodeProgramTarget;
	check: CodeCheckSpec;
}

export interface CodeDiagnosticRange { line: number; column?: number; endLine?: number; endColumn?: number; }
export interface CodeDiagnostic {
	resourceId: string;
	path: string;
	/** Only when trustworthy; never invented. */
	range?: CodeDiagnosticRange;
	severity: "error" | "warning" | "info";
	message: string;
	source: string;
}

export type ExecutionPhaseKind = "preparation" | "build" | "execution";
export type ExecutionPhaseStatus = "passed" | "failed" | "timeout" | "cancelled" | "output_limit" | "unavailable" | "not_run";
export interface ExecutionPhase {
	kind: ExecutionPhaseKind;
	status: ExecutionPhaseStatus;
	/** Check case an execution phase ran for. */
	caseId?: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface ExecutionEvidence {
	/** Identifies the resources, check specification, and profile version actually used. */
	snapshotId: string;
	toolchain?: { id: string; version?: string };
	phases: ExecutionPhase[];
	diagnostics: CodeDiagnostic[];
}

export type AssessmentVerdict = "passed" | "failed" | "not_run";
export interface AssessmentCaseResult { caseId: string; name: string; status: "passed" | "failed" | "not_run"; }
export interface AssessmentResult {
	checkKind: CodeCheckKind;
	verdict: AssessmentVerdict;
	cases: AssessmentCaseResult[];
}

/** Optional versioned detail attached to a CodeRunResult; absent on historical runs. */
export interface CodeRunDetail {
	version: 1;
	profile: { id: string; version: number };
	evidence: ExecutionEvidence;
	assessment: AssessmentResult;
}

export const CODE_LEARNER_RESOURCE_ID = "learner";
export const supportResourceId = (path: string) => `support:${path}`;

/** A relative, forward-slash path with no empty, `.` or `..` segments. */
export function validCodeResourcePath(path: unknown): path is string {
	if (typeof path !== "string" || !path || path.length > 200 || path.startsWith("/") || /[\\\0:]/.test(path)) return false;
	return path.split("/").every(part => part !== "" && part !== "." && part !== ".." && !/[\0-\x1f]/.test(part));
}

/** A path that is also a directory prefix of another (case-insensitive), e.g. `a.py` and `a.py/b.py`:
 *  the two cannot coexist on disk. Returns the clashing pair, if any. */
export function findPathConflict(paths: readonly string[]): [string, string] | undefined {
	const lower = paths.map(path => path.toLowerCase());
	for (let i = 0; i < paths.length; i++) {
		for (let j = 0; j < paths.length; j++) if (i !== j && lower[j]!.startsWith(`${lower[i]}/`)) return [paths[i]!, paths[j]!];
	}
	return undefined;
}

/** Pure normalization of the legacy authoring shape to the internal spec.
 *  Never mutates its input. Identity hashing happens on the legacy shape BEFORE
 *  this runs, so nothing here affects workspace IDs. */
export function normalizeCodeActivity(exercise: CodeExercise, supportFiles: readonly { path: string; source: string }[] = []): CodeActivitySpec {
	const profile = executableProfileFor(exercise.language);
	if (!profile) throw new Error(`No executable profile is registered for language '${exercise.language}'.`);
	const resources: CodeResource[] = [
		{ id: CODE_LEARNER_RESOURCE_ID, path: profile.entryFilename, content: exercise.starterCode, role: "learner", editable: true },
	];
	const seen = new Set([profile.entryFilename.toLowerCase()]);
	for (const file of supportFiles) {
		if (!validCodeResourcePath(file.path)) throw new Error(`Invalid resource path '${file.path}'.`);
		const key = file.path.toLowerCase();
		if (seen.has(key)) throw new Error(`Duplicate resource path '${file.path}'.`);
		seen.add(key);
		resources.push({ id: supportResourceId(file.path), path: file.path, language: profile.language, content: file.source, role: "support", editable: false });
	}
	const conflict = findPathConflict(resources.map(resource => resource.path));
	if (conflict) throw new Error(`Resource path '${conflict[0]}' conflicts with '${conflict[1]}'.`);
	if (resources.filter(resource => resource.role === "learner" && resource.editable).length !== 1) {
		throw new Error("An activity needs exactly one editable learner source.");
	}
	return {
		schemaVersion: 2,
		profile: { id: profile.id, version: profile.version },
		resources,
		target: { kind: "program", entryResourceId: CODE_LEARNER_RESOURCE_ID },
		check: { kind: "stdio", cases: exercise.tests.map((test, index) => ({ id: `case-${index + 1}`, ...test })) },
	};
}
