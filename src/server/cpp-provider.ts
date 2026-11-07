import * as path from "node:path";
import type { CodeActivitySpec, CodeDiagnostic, ExecutionPhase } from "../core/code-activity.ts";
import { parseCompilerDiagnostics } from "../core/code-diagnostics.ts";
import type { CodeProfileReadiness } from "../core/code-readiness.ts";
import type { CodeBuildContext, CodeBuildResult, CodeExecutionProvider } from "./code-provider.ts";
import { runProcess } from "./code-process.ts";

const TOOLCHAINS = ["clang++", "g++"];
const TOOLCHAIN_LABEL = "-std=c++20";
const MISSING = "A C++ compiler was not found. Install the Xcode Command Line Tools on macOS, or Clang/GCC on your system, then check again.";
const COMPILE_FLAGS = "-std=c++20\n-Wall\n-Wextra\n";

/** Source files compiled together: the entry file, then supporting .cpp files in order. */
function selectSources(spec: CodeActivitySpec, explicit?: string[]): string[] {
	const entry = spec.resources.find(resource => resource.id === spec.target.entryResourceId)!;
	const all = spec.resources.map(resource => resource.path);
	if (!explicit) return [entry.path, ...spec.resources.filter(resource => resource.role === "support" && resource.path.endsWith(".cpp")).map(resource => resource.path)];
	if (!explicit.length || new Set(explicit).size !== explicit.length || explicit.some(name => !all.includes(name) || !name.endsWith(".cpp"))) throw new Error("Invalid compilation sources.");
	return explicit;
}

/** Trusted C++20 provider: fixed compiler argv, clang++/g++ selection, Clang/GCC diagnostics. */
export const cppProvider: CodeExecutionProvider = {
	profileId: "cpp20-stdio",

	async readiness(): Promise<CodeProfileReadiness> {
		for (const candidate of TOOLCHAINS) {
			const probe = await runProcess(candidate, ["--version"], process.cwd(), "", 5_000);
			if (!probe.unavailable && probe.exitCode === 0) {
				return { profileId: this.profileId, state: "ready", toolchain: { id: candidate, ...(probe.stdout.split("\n")[0]?.trim() ? { version: probe.stdout.split("\n")[0]!.trim() } : {}) } };
			}
		}
		return { profileId: this.profileId, state: "unavailable", message: MISSING };
	},

	buildSources: selectSources,

	// Editor tooling reads this; existing saved scaffolding is never overwritten.
	scaffoldFiles: () => [{ path: "compile_flags.txt", content: COMPILE_FLAGS }],

	async build(context: CodeBuildContext): Promise<CodeBuildResult> {
		const sources = selectSources(context.spec, context.explicitSources);
		const executable = path.join(context.directory, process.platform === "win32" ? "solution.exe" : "solution");
		const args = ["-std=c++20", "-Wall", "-Wextra", "-pedantic", "-O0", "-I", context.directory, ...sources.map(file => path.join(context.directory, file)), "-o", executable];
		let label = "";
		let compilation;
		let toolchain = "";
		for (const candidate of context.toolchainCandidates ?? TOOLCHAINS) {
			toolchain = candidate;
			label = `${candidate} ${TOOLCHAIN_LABEL}`.trim();
			compilation = await context.run(candidate, args, context.directory, "", context.timeoutMs, context.signal);
			if (!compilation.unavailable) break;
		}
		if (!compilation || compilation.unavailable) {
			return { toolchainLabel: label, phase: { kind: "build", status: "unavailable", exitCode: null, stdout: "", stderr: MISSING }, diagnostics: [], unavailableMessage: MISSING };
		}
		const status: ExecutionPhase["status"] = compilation.cancelled ? "cancelled" : compilation.timedOut ? "timeout" : compilation.exitCode === 0 ? "passed" : "failed";
		const base = { toolchain: { id: toolchain }, toolchainLabel: label, diagnostics: diagnose(context.spec, `${compilation.stdout}\n${compilation.stderr}`) };
		const phase = { kind: "build" as const, status, exitCode: compilation.exitCode, stdout: compilation.stdout, stderr: compilation.stderr };
		return status === "passed" ? { ...base, phase, program: { command: executable, args: [] } } : { ...base, phase };
	},
};

/** Attribute each Clang/GCC diagnostic to the resource it names, never to the learner file by default. */
function diagnose(spec: CodeActivitySpec, output: string): CodeDiagnostic[] {
	const diagnostics: CodeDiagnostic[] = [];
	for (const resource of spec.resources) {
		if (!/\.(?:cpp|h|hpp)$/.test(resource.path)) continue;
		for (const item of parseCompilerDiagnostics(output, resource.path)) {
			diagnostics.push({ resourceId: resource.id, path: resource.path, range: { line: item.line, column: item.column, ...(item.endColumn ? { endLine: item.line, endColumn: item.endColumn } : {}) }, severity: item.severity, message: item.message, source: "compiler" });
		}
	}
	return diagnostics;
}
