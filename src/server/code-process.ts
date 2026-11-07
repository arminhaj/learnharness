import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { CODE_SOURCE_LIMIT, CODE_TEST_LIMIT, CODE_TEST_TEXT_LIMIT } from "../core/code-workspace.ts";

export const OUTPUT_LIMIT = 64 * 1024;

/** Upper bound for one saved CodeRunResult JSON file, derived from the execution limits:
 *  the build and each of the (at most) CODE_TEST_LIMIT case processes emit at most OUTPUT_LIMIT
 *  bytes of stdout+stderr combined, plus appended notices; that text is stored twice (legacy
 *  tests/build fields and the evidence phases); JSON escaping can expand a control character
 *  to six bytes (\u00XX); the record also carries the source and the check inputs once. */
const PROCESS_TEXT_BOUND = OUTPUT_LIMIT + 1024;
const JSON_ESCAPE_FACTOR = 6;
export const CODE_RUN_RECORD_LIMIT =
	(CODE_TEST_LIMIT + 1) * 2 * PROCESS_TEXT_BOUND * JSON_ESCAPE_FACTOR
	+ (CODE_SOURCE_LIMIT + CODE_TEST_LIMIT * (2 * CODE_TEST_TEXT_LIMIT + 120)) * JSON_ESCAPE_FACTOR
	+ 64 * 1024;
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

export interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	/** True for a time limit or a cancellation (kept for the legacy facade). */
	timedOut: boolean;
	cancelled: boolean;
	outputLimited: boolean;
	unavailable: boolean;
}

/** Run one fixed command. Callers supply trusted argv; nothing here parses a command string. */
export function runProcess(command: string, args: string[], cwd: string, stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
	return new Promise((resolve) => {
		let stdout = "", stderr = "", size = 0, timedOut = false, cancelled = false, outputLimited = false, done = false;
		// Decode per stream so a multi-byte character split across chunks stays intact.
		const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
		const child = spawn(command, args, { cwd, env: codeProcessEnvironment(cwd), shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		const kill = () => {
			try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Process already stopped. */ }
		};
		const finish = (exitCode: number | null, unavailable = false) => {
			if (done) return;
			done = true;
			// Flush each stream's decoder exactly once: an incomplete trailing UTF-8 sequence
			// becomes a replacement character instead of silently vanishing.
			stdout += decoders.stdout.end();
			stderr += decoders.stderr.end();
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			resolve({ stdout, stderr, exitCode, timedOut, cancelled, outputLimited, unavailable });
		};
		const cancel = () => { timedOut = true; cancelled = true; stderr += "\nCheck cancelled."; kill(); };
		const timer = setTimeout(() => { timedOut = true; stderr += "\nTime limit exceeded."; kill(); }, timeoutMs);
		const append = (buffer: Buffer, target: "stdout" | "stderr") => {
			const remaining = Math.max(0, OUTPUT_LIMIT - size);
			const text = decoders[target].write(buffer.subarray(0, remaining));
			if (target === "stdout") stdout += text; else stderr += text;
			size += buffer.length;
			if (size > OUTPUT_LIMIT) { outputLimited = true; stderr += "\nOutput limit exceeded; process stopped."; kill(); }
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
