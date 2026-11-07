import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeCodeActivity, type CodeDiagnostic, type ExecutionEvidence, type ExecutionPhase } from "../core/code-activity.ts";
import { assessStdio } from "../core/code-assessment.ts";
import { executableLanguageNames, executableProfileFor } from "../core/code-language-catalog.ts";
import type { CodeExercise, CodeRunResult, CodeTestResult } from "../core/code-workspace.ts";
import { codeProcessEnvironment, runProcess, type ProcessResult } from "./code-process.ts";
import { providerForProfile, snapshotIdFor } from "./code-providers.ts";
import type { CodeBuildResult } from "./code-provider.ts";

export { codeProcessEnvironment };

export interface CodeRunnerOptions {
	/** Server/test configuration only; never accepted from an HTTP request. */
	compilerCandidates?: string[];
	compileTimeoutMs?: number;
	testTimeoutMs?: number;
	signal?: AbortSignal;
}

export interface CodeRunnerInput {
	workspaceId: string;
	source: string;
	revision: string;
	exercise: CodeExercise;
	/** Trusted, server-owned project content. Never accepted as an HTTP command. */
	supportFiles?: { path: string; source: string }[];
	/** Trusted override of the build sources; by default the provider selects them. */
	compileSources?: string[];
}

function validateProject(input: CodeRunnerInput, filename: string) {
	const files = [{ path: filename, source: input.source }, ...(input.supportFiles ?? [])];
	const seen = new Set<string>();
	let size = 0;
	if (files.length > 32) throw new Error("A code project may contain at most 32 files.");
	for (const file of files) {
		if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(file.path) || file.path.split("/").some((part) => !part || part === "." || part === "..") || seen.has(file.path.toLowerCase())) throw new Error("Invalid or duplicate code project path.");
		seen.add(file.path.toLowerCase());
		size += Buffer.byteLength(file.source, "utf8");
	}
	if (size > 512 * 1024) throw new Error("A code project must be at most 512 KiB.");
	return files;
}

type PhaseStatus = ExecutionPhase["status"];
function executionStatus(run: ProcessResult): PhaseStatus {
	return run.cancelled ? "cancelled" : run.timedOut ? "timeout" : run.outputLimited ? "output_limit" : run.exitCode !== 0 ? "failed" : "passed";
}

const DIAGNOSTIC_LIMIT = 50;
interface Execution { caseId?: string; stdin: string; phase: ExecutionPhase; }
interface Pipeline {
	snapshotId: string;
	profile: { id: string; version: number };
	build: CodeBuildResult;
	executions: Execution[];
	/** Structured diagnostics extracted from failed executions (tracebacks). */
	runtimeDiagnostics: CodeDiagnostic[];
	spec: ReturnType<typeof normalizeCodeActivity>;
}

/** Resolve a normalized snapshot, build it through the profile's provider, then
 *  run the given inputs. Assessment is a separate step over the evidence. */
async function runPipeline(input: CodeRunnerInput, options: CodeRunnerOptions, inputs: "checks" | { stdin: string }[]): Promise<Pipeline | { unsupported: true }> {
	const profile = executableProfileFor(input.exercise.language);
	const provider = profile ? providerForProfile(profile.id) : undefined;
	if (!profile || !provider) return { unsupported: true };
	const files = validateProject(input, profile.entryFilename);
	// Normalization happens after the legacy exercise/identity is fixed; it adds nothing to it.
	const spec = normalizeCodeActivity({ ...input.exercise, starterCode: input.source }, input.supportFiles ?? []);
	const snapshotId = snapshotIdFor(spec, input.compileSources);
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-code-"));
	try {
		for (const file of files) {
			const target = path.join(directory, file.path);
			await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			await fs.writeFile(target, file.source, { encoding: "utf8", mode: 0o600, flag: "wx" });
		}
		const build = await provider.build({
			directory, spec, timeoutMs: options.compileTimeoutMs ?? 30_000, signal: options.signal, run: runProcess,
			...(options.compilerCandidates ? { toolchainCandidates: options.compilerCandidates } : {}),
			...(input.compileSources ? { explicitSources: input.compileSources } : {}),
		});
		const executions: Execution[] = [];
		const runtimeDiagnostics: CodeDiagnostic[] = [];
		const base = { snapshotId, profile: { id: profile.id, version: profile.version }, build, executions, runtimeDiagnostics, spec };
		if (!build.program) return base;
		const planned = inputs === "checks" ? spec.check.cases.map(item => ({ caseId: item.id, stdin: item.stdin })) : inputs.map(item => ({ caseId: undefined, stdin: item.stdin }));
		for (const item of planned) {
			const run = await runProcess(build.program.command, build.program.args, directory, item.stdin, options.testTimeoutMs ?? 5_000, options.signal);
			const phase: ExecutionPhase = { kind: "execution", status: executionStatus(run), ...(item.caseId ? { caseId: item.caseId } : {}), exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
			executions.push({ ...(item.caseId ? { caseId: item.caseId } : {}), stdin: item.stdin, phase });
			if (phase.status !== "passed" && run.stderr && provider.executionDiagnostics) {
				const known = new Set(runtimeDiagnostics.map(diagnostic => JSON.stringify(diagnostic)));
				for (const diagnostic of provider.executionDiagnostics({ directory, spec, stderr: run.stderr })) {
					if (runtimeDiagnostics.length < DIAGNOSTIC_LIMIT && !known.has(JSON.stringify(diagnostic))) runtimeDiagnostics.push(diagnostic);
				}
			}
			if (run.timedOut || options.signal?.aborted) break;
		}
		return base;
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

function evidenceOf(pipeline: Pipeline): ExecutionEvidence {
	return {
		snapshotId: pipeline.snapshotId,
		...(pipeline.build.toolchain ? { toolchain: pipeline.build.toolchain } : {}),
		phases: [pipeline.build.phase, ...pipeline.executions.map(execution => execution.phase)],
		diagnostics: [...pipeline.build.diagnostics, ...pipeline.runtimeDiagnostics].slice(0, DIAGNOSTIC_LIMIT),
	};
}

/** Check the exercise: build, run every case, then assess the evidence. Returns the
 *  legacy result facade with the versioned evidence attached. */
export async function runCodeExercise(input: CodeRunnerInput, options: CodeRunnerOptions = {}): Promise<CodeRunResult> {
	const result: CodeRunResult = { id: randomUUID(), workspaceId: input.workspaceId, source: input.source, revision: input.revision, language: input.exercise.language, status: "unavailable", compiler: "", stdout: "", stderr: "", tests: [], createdAt: new Date().toISOString() };
	const pipeline = await runPipeline(input, options, "checks");
	if ("unsupported" in pipeline) return { ...result, stderr: `No local runner for ${input.exercise.language}. This version supports ${executableLanguageNames()}.` };
	const { build } = pipeline;
	result.compiler = build.toolchainLabel;
	const evidence = evidenceOf(pipeline);
	const assessment = assessStdio(pipeline.spec.check, pipeline.executions.flatMap(execution => execution.caseId ? [{ caseId: execution.caseId, completed: execution.phase.status === "passed", stdout: execution.phase.stdout }] : []));
	const detail = { version: 1 as const, profile: pipeline.profile, evidence, assessment };
	if (build.phase.status === "unavailable") return { ...result, stderr: build.unavailableMessage ?? build.phase.stderr, detail };
	result.stdout = build.phase.stdout;
	result.stderr = build.phase.stderr;
	if (build.phase.status === "timeout" || build.phase.status === "cancelled") return { ...result, status: "timeout", detail };
	if (build.phase.status !== "passed") return { ...result, status: build.phase.kind === "preparation" ? "preparation_error" : "compilation_error", detail };
	const byCase = new Map(assessment.cases.map(item => [item.caseId, item]));
	for (const execution of pipeline.executions) {
		const test = pipeline.spec.check.cases.find(item => item.id === execution.caseId)!;
		const assessed = byCase.get(test.id)!;
		const status: CodeTestResult["status"] = assessed.status === "passed" ? "passed" : assessed.status === "failed" ? "failed" : execution.phase.status === "timeout" || execution.phase.status === "cancelled" ? "timeout" : "runtime_error";
		result.tests.push({ name: test.name, stdin: test.stdin, expectedStdout: test.expectedStdout, stdout: execution.phase.stdout, stderr: execution.phase.stderr, status, exitCode: execution.phase.exitCode });
	}
	result.status = result.tests.some((test) => test.status === "timeout") ? "timeout" : result.tests.some((test) => test.status === "runtime_error") ? "runtime_error" : result.tests.some((test) => test.status === "failed") ? "tests_failed" : "passed";
	return { ...result, detail };
}

export interface CodeProgramResult {
	id: string;
	source: string;
	revision: string;
	status: "completed" | "compilation_error" | "preparation_error" | "runtime_error" | "timeout" | "unavailable";
	compiler: string;
	stdout: string;
	stderr: string;
	compilerStdout: string;
	compilerStderr: string;
	stdin: string;
	createdAt: string;
}

/** Execute one input through the same build pipeline. There is no check case and no verdict. */
export async function runCodeProgram(input: CodeRunnerInput, stdin: string, options: CodeRunnerOptions = {}): Promise<CodeProgramResult> {
	const result: CodeProgramResult = { id: randomUUID(), source: input.source, revision: input.revision, status: "unavailable", compiler: "", stdout: "", stderr: "", compilerStdout: "", compilerStderr: "", stdin, createdAt: new Date().toISOString() };
	const pipeline = await runPipeline(input, options, [{ stdin }]);
	if ("unsupported" in pipeline) return { ...result, compilerStderr: `No local runner for ${input.exercise.language}. This version supports ${executableLanguageNames()}.` };
	const { build } = pipeline;
	result.compiler = build.toolchainLabel;
	if (build.phase.status === "unavailable") return { ...result, compilerStderr: build.unavailableMessage ?? build.phase.stderr };
	result.compilerStdout = build.phase.stdout;
	result.compilerStderr = build.phase.stderr;
	if (build.phase.status === "timeout" || build.phase.status === "cancelled") return { ...result, status: "timeout" };
	if (build.phase.status !== "passed") return { ...result, status: build.phase.kind === "preparation" ? "preparation_error" : "compilation_error" };
	const run = pipeline.executions[0]?.phase;
	if (!run) return result;
	return {
		...result, stdout: run.stdout, stderr: run.stderr,
		status: run.status === "passed" ? "completed" : run.status === "timeout" || run.status === "cancelled" ? "timeout" : "runtime_error",
	};
}
