import type { CodeActivitySpec, CodeDiagnostic, ExecutionPhase } from "../core/code-activity.ts";
import type { CodeProfileReadiness } from "../core/code-readiness.ts";
import type { ProcessResult } from "./code-process.ts";

/** What a provider needs to build one prepared activity. All values are server-owned. */
export interface CodeBuildContext {
	/** Directory holding the written resources. */
	directory: string;
	spec: CodeActivitySpec;
	/** Server/test configuration only; never accepted from an HTTP request. */
	toolchainCandidates?: string[];
	/** Trusted caller override of the program's build sources (the prepared API demo). */
	explicitSources?: string[];
	timeoutMs: number;
	signal?: AbortSignal;
	run: (command: string, args: string[], cwd: string, stdin: string, timeoutMs: number, signal?: AbortSignal) => Promise<ProcessResult>;
}

export interface CodeBuildResult {
	toolchain?: { id: string; version?: string };
	/** Legacy one-line toolchain description, e.g. "clang++ -std=c++20". */
	toolchainLabel: string;
	/** The preparation/build phase; `unavailable` when no toolchain was found. */
	phase: ExecutionPhase;
	diagnostics: CodeDiagnostic[];
	/** Present only when the phase passed: the fixed command that runs the program. */
	program?: { command: string; args: string[] };
	/** Actionable explanation when the toolchain is missing. */
	unavailableMessage?: string;
}

/** Trusted server-side boundary for one execution profile. Providers own
 *  executable selection, fixed argv construction, scaffolding, and diagnostic
 *  extraction; model-authored data or HTTP requests never supply those.
 *  Nothing is probed at import time: readiness is computed on demand. */
export interface CodeExecutionProvider {
	profileId: string;
	readiness(): Promise<CodeProfileReadiness>;
	/** Non-resource files written once beside a new workspace; never overwritten. */
	scaffoldFiles(spec: CodeActivitySpec): { path: string; content: string }[];
	/** The effective ordered build-source selection: the default, or a validated trusted override.
	 *  Throws on an invalid override. Part of the execution snapshot. */
	buildSources(spec: CodeActivitySpec, explicit?: string[]): string[];
	/** Build with fixed argv, and extract diagnostics. Throws on an invalid source override. */
	build(context: CodeBuildContext): Promise<CodeBuildResult>;
	/** Structured diagnostics from a failed execution's raw output (e.g. a traceback), mapped
	 *  only to real workspace resources. Optional: absent for profiles without such output. */
	executionDiagnostics?(context: { directory: string; spec: CodeActivitySpec; stderr: string }): CodeDiagnostic[];
}
