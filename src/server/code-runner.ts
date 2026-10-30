import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { CodeExercise, CodeRunResult, CodeTestResult } from "../core/code-workspace.ts";

const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

/** Intentionally a trusted local runner, not an OS sandbox. Never inherit API keys. */
export function codeProcessEnvironment(directory: string): NodeJS.ProcessEnv {
	return {
		NODE_ENV: "production",
		PATH: process.env.PATH || DEFAULT_PATH,
		HOME: directory,
		TMPDIR: directory,
		TMP: directory,
		TEMP: directory,
		LANG: "C",
		LC_ALL: "C",
		...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
	};
}

interface ProcessResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; unavailable: boolean; }
function runProcess(command: string, args: string[], cwd: string, stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
	return new Promise((resolve) => {
		let stdout = "", stderr = "", size = 0, timedOut = false, done = false;
		const child = spawn(command, args, { cwd, env: codeProcessEnvironment(cwd), shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		const kill = () => {
			try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Process already stopped. */ }
		};
		const finish = (exitCode: number | null, unavailable = false) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			resolve({ stdout, stderr, exitCode, timedOut, unavailable });
		};
		const cancel = () => { timedOut = true; stderr += "\nCheck cancelled."; kill(); };
		const timer = setTimeout(() => { timedOut = true; stderr += "\nTime limit exceeded."; kill(); }, timeoutMs);
		const append = (buffer: Buffer, target: "stdout" | "stderr") => {
			const remaining = Math.max(0, OUTPUT_LIMIT - size);
			const text = buffer.subarray(0, remaining).toString("utf8");
			if (target === "stdout") stdout += text; else stderr += text;
			size += buffer.length;
			if (size > OUTPUT_LIMIT) { stderr += "\nOutput limit exceeded; process stopped."; kill(); }
		};
		child.stdout.on("data", (data: Buffer) => append(data, "stdout"));
		child.stderr.on("data", (data: Buffer) => append(data, "stderr"));
		child.stdin.on("error", () => { /* Early exits can close stdin before the test input is consumed. */ });
		child.on("error", (error: NodeJS.ErrnoException) => { stderr += error.message; finish(null, error.code === "ENOENT"); });
		child.on("close", (code) => { kill(); finish(code); });
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel(); else child.stdin.end(stdin);
	});
}

interface LanguageAdapter {
	filename: string;
	toolchains: string[];
	toolchainLabel: string;
	missingMessage: string;
	/** Omit for interpreted languages; those probe the runtime before executing tests. */
	compileArgs?: (sources: string[], executable: string, directory: string) => string[];
	probeArgs?: string[];
	execution: (toolchain: string, source: string, executable: string) => { command: string; args: string[] };
}
/** Compiled and interpreted languages share the pipeline; adapters own fixed argv. */
const ADAPTERS: Record<string, LanguageAdapter> = {
	cpp: {
		filename: "solution.cpp", toolchains: ["clang++", "g++"], toolchainLabel: "-std=c++20",
		missingMessage: "A C++ compiler was not found. Install the Xcode Command Line Tools on macOS, or Clang/GCC on your system, then check again.",
		compileArgs: (sources, executable, directory) => ["-std=c++20", "-Wall", "-Wextra", "-pedantic", "-O0", "-I", directory, ...sources, "-o", executable],
		execution: (_toolchain, _source, executable) => ({ command: executable, args: [] }),
	},
};

export function codeFilename(language: string): string { return ADAPTERS[language]?.filename ?? "solution.txt"; }
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
	compileSources?: string[];
}

function projectFiles(input: CodeRunnerInput, filename: string): { files: { path: string; source: string }[]; compileSources: string[] } {
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
	const compileSources = input.compileSources ?? [filename];
	if (!compileSources.length || new Set(compileSources).size !== compileSources.length || compileSources.some((name) => !files.some((file) => file.path === name) || input.exercise.language === "cpp" && !name.endsWith(".cpp"))) throw new Error("Invalid compilation sources.");
	return { files, compileSources };
}

export async function runCodeExercise(input: CodeRunnerInput, options: CodeRunnerOptions = {}): Promise<CodeRunResult> {
	const result: CodeRunResult = { id: randomUUID(), workspaceId: input.workspaceId, source: input.source, revision: input.revision, language: input.exercise.language, status: "unavailable", compiler: "", stdout: "", stderr: "", tests: [], createdAt: new Date().toISOString() };
	const adapter = ADAPTERS[input.exercise.language];
	if (!adapter) return { ...result, stderr: `No local runner for ${input.exercise.language}. This version supports C++.` };
	const project = projectFiles(input, adapter.filename);
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-code-"));
	try {
		const source = path.join(directory, adapter.filename);
		const executable = path.join(directory, process.platform === "win32" ? "solution.exe" : "solution");
		for (const file of project.files) {
			const target = path.join(directory, file.path);
			await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			await fs.writeFile(target, file.source, { encoding: "utf8", mode: 0o600, flag: "wx" });
		}
		let compilation: ProcessResult | undefined;
		let toolchain = "";
		for (const candidate of options.compilerCandidates ?? adapter.toolchains) {
			toolchain = candidate;
			result.compiler = `${toolchain} ${adapter.toolchainLabel}`.trim();
			const args = adapter.compileArgs?.(project.compileSources.map((file) => path.join(directory, file)), executable, directory) ?? adapter.probeArgs ?? ["--version"];
			compilation = await runProcess(toolchain, args, directory, "", options.compileTimeoutMs ?? 30_000, options.signal);
			if (!compilation.unavailable) break;
		}
		if (!compilation || compilation.unavailable) return { ...result, stderr: adapter.missingMessage };
		result.stdout = compilation.stdout;
		result.stderr = compilation.stderr;
		if (compilation.timedOut) return { ...result, status: "timeout" };
		if (compilation.exitCode !== 0) return { ...result, status: adapter.compileArgs ? "compilation_error" : "unavailable" };
		const executionCommand = adapter.execution(toolchain, source, executable);
		for (const test of input.exercise.tests) {
			const execution = await runProcess(executionCommand.command, executionCommand.args, directory, test.stdin, options.testTimeoutMs ?? 5_000, options.signal);
			// Ignore only final line endings; interior whitespace is part of the answer.
			const normalized = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
			const status: CodeTestResult["status"] = execution.timedOut ? "timeout" : execution.exitCode !== 0 ? "runtime_error" : normalized(execution.stdout) === normalized(test.expectedStdout) ? "passed" : "failed";
			result.tests.push({ ...test, stdout: execution.stdout, stderr: execution.stderr, status, exitCode: execution.exitCode });
			if (status === "timeout" || options.signal?.aborted) break;
		}
		result.status = result.tests.some((test) => test.status === "timeout") ? "timeout" : result.tests.some((test) => test.status === "runtime_error") ? "runtime_error" : result.tests.some((test) => test.status === "failed") ? "tests_failed" : "passed";
		return result;
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

export interface CodeProgramResult {
	id: string;
	source: string;
	revision: string;
	status: "completed" | "compilation_error" | "runtime_error" | "timeout" | "unavailable";
	compiler: string;
	stdout: string;
	stderr: string;
	compilerStdout: string;
	compilerStderr: string;
	stdin: string;
	createdAt: string;
}

/** Execute one input through the same build pipeline, without a correctness verdict. */
export async function runCodeProgram(input: CodeRunnerInput, stdin: string, options: CodeRunnerOptions = {}): Promise<CodeProgramResult> {
	const result = await runCodeExercise({ ...input, exercise: { ...input.exercise, tests: [{ name: "Custom run", stdin, expectedStdout: "" }] } }, options);
	const process = result.tests[0];
	return {
		id: result.id, source: result.source, revision: result.revision,
		status: result.status === "passed" || result.status === "tests_failed" ? "completed" : result.status,
		compiler: result.compiler, stdout: process?.stdout ?? "", stderr: process?.stderr ?? "",
		compilerStdout: result.stdout, compilerStderr: result.stderr, stdin, createdAt: result.createdAt,
	};
}
