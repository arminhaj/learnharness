import * as fs from "node:fs";
import * as os from "node:os";
import type { CodeActivitySpec, CodeDiagnostic, ExecutionPhase } from "../core/code-activity.ts";
import type { CodeProfileReadiness } from "../core/code-readiness.ts";
import type { CodeBuildContext, CodeBuildResult, CodeExecutionProvider } from "./code-provider.ts";
import { runProcess } from "./code-process.ts";

/** Minimum interpreter version for the python3-stdio profile. */
const MINIMUM = { major: 3, minor: 11 };
/** Approved interpreter configuration for learner programs: ignore PYTHON* variables, skip
 *  site initialization, write no bytecode, unbuffered output; `-X utf8` keeps Unicode I/O
 *  consistent under the sanitized C locale. The script directory stays on sys.path so local
 *  supporting modules import. This is interpreter configuration, not an OS sandbox. */
const RUN_FLAGS = ["-E", "-S", "-B", "-u", "-X", "utf8"];
/** Trusted helper flags: isolated mode also removes the working directory from sys.path, so a
 *  supporting module such as json.py can never be imported by the helper itself. */
const HELPER_FLAGS = ["-I", "-S", "-B", "-X", "utf8"];

interface Candidate { command: string; args: string[]; }
const defaultCandidates = (): Candidate[] => [
	{ command: "python3", args: [] },
	{ command: "python", args: [] },
	...(process.platform === "win32" ? [{ command: "py", args: ["-3"] }] : []),
];
const describe = (candidate: Candidate) => [candidate.command, ...candidate.args].join(" ");

const PROBE = "import sys; print('%d.%d.%d' % sys.version_info[:3])";

/** Trusted syntax-validation helper. compile() parses without executing the code and writes no
 *  bytecode. Prints a JSON array of {path, error?}; exits 1 when any file has an error. */
const HELPER = `
import sys, json
out = []
for name in sys.argv[1:]:
    entry = {"path": name}
    try:
        with open(name, "rb") as handle:
            data = handle.read()
        compile(data, name, "exec", dont_inherit=True)
    except SyntaxError as error:
        entry["error"] = {"type": type(error).__name__, "msg": error.msg, "line": error.lineno, "col": error.offset, "endLine": getattr(error, "end_lineno", None), "endCol": getattr(error, "end_offset", None)}
    except Exception as error:
        entry["error"] = {"type": type(error).__name__, "msg": str(error), "line": None, "col": None, "endLine": None, "endCol": None}
    out.append(entry)
sys.stdout.write(json.dumps(out))
sys.exit(1 if any("error" in entry for entry in out) else 0)
`;

type Runner = CodeBuildContext["run"];
export interface PythonInterpreter { command: string; args: string[]; version: string; }
export type PythonDiscovery =
	| { interpreter: PythonInterpreter; message?: undefined; cancelled?: undefined }
	| { interpreter?: undefined; message: string; cancelled?: undefined }
	/** The caller cancelled while candidates were being probed: not a missing runtime. */
	| { interpreter?: undefined; message?: undefined; cancelled: true };

const MISSING_ADVICE = "Install Python 3.11 or newer (python.org or your package manager) so `python3` or `python` is on your PATH, then check again.";

/** Try each trusted candidate in order and verify the ACTUAL version: a missing launcher, a
 *  stub that prints something else, or an older Python is skipped, not mistaken for a runtime. */
export async function discoverPython(candidates: Candidate[], run: Runner, cwd: string, signal?: AbortSignal): Promise<PythonDiscovery> {
	let older: string | undefined;
	for (const candidate of candidates) {
		if (signal?.aborted) return { cancelled: true };
		const probe = await run(candidate.command, [...candidate.args, ...HELPER_FLAGS, "-c", PROBE], cwd, "", 10_000, signal);
		if (probe.cancelled) return { cancelled: true };
		if (probe.unavailable || probe.exitCode !== 0 || probe.timedOut) continue;
		const match = /^(\d+)\.(\d+)\.(\d+)\s*$/.exec(probe.stdout);
		if (!match) continue;
		const version = `${match[1]}.${match[2]}.${match[3]}`;
		const major = Number(match[1]), minor = Number(match[2]);
		if (major > MINIMUM.major || major === MINIMUM.major && minor >= MINIMUM.minor) return { interpreter: { ...candidate, version } };
		older ??= `Python ${version} (${describe(candidate)})`;
	}
	return { message: older
		? `Python 3.11 or newer is required, but only ${older} was found. ${MISSING_ADVICE}`
		: `Python 3.11 or newer was not found. ${MISSING_ADVICE}` };
}

const candidatesFor = (explicit?: string[]): Candidate[] => explicit ? explicit.map(command => ({ command, args: [] })) : defaultCandidates();

/** Entry first, then every supporting .py module, in resource order. */
function selectSources(spec: CodeActivitySpec, explicit?: string[]): string[] {
	if (explicit) throw new Error("Invalid compilation sources.");
	const entry = spec.resources.find(resource => resource.id === spec.target.entryResourceId)!;
	return [entry.path, ...spec.resources.filter(resource => resource.role === "support" && resource.path.endsWith(".py")).map(resource => resource.path)];
}

interface HelperError { type: string; msg: string; line: number | null; col: number | null; endLine: number | null; endCol: number | null; }
function parseHelper(stdout: string): { path: string; error?: HelperError }[] | undefined {
	try {
		const value: unknown = JSON.parse(stdout);
		if (!Array.isArray(value)) return undefined;
		return value.filter((entry): entry is { path: string; error?: HelperError } => !!entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string");
	} catch { return undefined; }
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** Python reports 1-based CODE POINT offsets; the editor counts UTF-16 units. Convert from the
 *  original line, or return undefined when the position cannot be trusted. */
function editorColumn(lines: string[] | undefined, line: number | null, offset: number | null): number | undefined {
	if (!lines || !positive(line) || !positive(offset) || line > lines.length) return undefined;
	const points = Array.from(lines[line - 1]!);
	if (offset > points.length + 1) return undefined;
	return points.slice(0, offset - 1).join("").length + 1;
}

/** Lines as Python numbers them, or undefined when offsets would not map onto the JS string
 *  (a BOM, or a source-encoding declaration other than UTF-8). */
function sourceLines(content: string): string[] | undefined {
	if (content.startsWith("\uFEFF")) return undefined;
	const lines = content.split(/\r\n|\r|\n/);
	for (const line of lines.slice(0, 2)) {
		const cookie = /^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)/.exec(line)?.[1];
		if (cookie && !/^utf-?8(?:-sig)?$/i.test(cookie)) return undefined;
	}
	return lines;
}

function syntaxDiagnostics(spec: CodeActivitySpec, entries: { path: string; error?: HelperError }[]): { diagnostics: CodeDiagnostic[]; text: string } {
	const diagnostics: CodeDiagnostic[] = [];
	const lines: string[] = [];
	for (const entry of entries) {
		const error = entry.error;
		const resource = spec.resources.find(item => item.path === entry.path);
		if (!error || !resource) continue;
		const where = positive(error.line) ? positive(error.col) ? `${entry.path}:${error.line}:${error.col}` : `${entry.path}:${error.line}` : entry.path;
		const message = `${error.type}: ${error.msg}`;
		lines.push(`${where}: ${message}`);
		// A location is reported only when Python supplied one; the column only when it converts
		// reliably to the editor's UTF-16 columns.
		const rows = sourceLines(resource.content);
		const column = editorColumn(rows, error.line, error.col);
		const endLine = positive(error.endLine) ? error.endLine : error.line;
		const endColumn = column === undefined ? undefined : editorColumn(rows, endLine, error.endCol);
		const sameLine = endLine === error.line;
		const range = positive(error.line) ? {
			line: error.line,
			...(column !== undefined ? { column } : {}),
			...(column !== undefined && positive(error.endLine) ? { endLine: error.endLine } : {}),
			...(endColumn !== undefined && (!sameLine || endColumn > column!) ? { endColumn } : {}),
		} : undefined;
		diagnostics.push({ resourceId: resource.id, path: resource.path, ...(range ? { range } : {}), severity: "error", message, source: "python" });
	}
	return { diagnostics, text: lines.join("\n") };
}

const NOTICES = new Set(["Time limit exceeded.", "Check cancelled.", "Output limit exceeded; process stopped."]);

/** Frames of the last traceback, mapped to workspace resources only. The innermost workspace
 *  frame carries the exception; outer ones are informational. Lines only: a traceback caret is
 *  not a reliable token position. */
function tracebackDiagnostics(spec: CodeActivitySpec, directory: string, stderr: string): CodeDiagnostic[] {
	const marker = stderr.lastIndexOf("Traceback (most recent call last):");
	const block = marker >= 0 ? stderr.slice(marker) : stderr;
	const frames = [...block.matchAll(/^\s*File "([^"]+)", line (\d+)(?:, in (.+))?$/gm)];
	if (frames.length === 0) return [];
	const summary = block.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line && !/^\s/.test(line) && !NOTICES.has(line.trim()) && !line.startsWith("Traceback (most recent call last):")).at(-1) ?? "Python raised an exception";
	let real = directory;
	try { real = fs.realpathSync(directory); } catch { /* Use the lexical path. */ }
	const relative = (file: string): string | undefined => {
		const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
		for (const root of [directory, real]) {
			const prefix = `${root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
			if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
		}
		return /^(?:[A-Za-z]:)?\//.test(normalized) ? undefined : normalized;
	};
	const mapped = frames.flatMap(frame => {
		const rel = relative(frame[1]!);
		const resource = rel === undefined ? undefined : spec.resources.find(item => item.path === rel);
		return resource ? [{ resource, line: Number(frame[2]), name: frame[3] }] : [];
	}).filter(frame => positive(frame.line));
	if (mapped.length === 0) return [];
	return mapped.map((frame, index): CodeDiagnostic => {
		const innermost = index === mapped.length - 1;
		return { resourceId: frame.resource.id, path: frame.resource.path, range: { line: frame.line }, severity: innermost ? "error" : "info", message: innermost ? summary : `Called from here${frame.name ? ` (in ${frame.name})` : ""}.`, source: "python" };
	});
}

/** Trusted Python provider: discovered interpreter, fixed flags, syntax preparation, traceback mapping. */
export const pythonProvider: CodeExecutionProvider = {
	profileId: "python3-stdio",

	async readiness(): Promise<CodeProfileReadiness> {
		const found = await discoverPython(defaultCandidates(), runProcess, os.tmpdir());
		return found.interpreter
			? { profileId: this.profileId, state: "ready", toolchain: { id: describe(found.interpreter), version: found.interpreter.version } }
			: { profileId: this.profileId, state: "unavailable", message: found.message };
	},

	// Python needs no editor-tooling scaffold (no compile_flags.txt equivalent).
	scaffoldFiles: () => [],

	buildSources: selectSources,

	async build(context: CodeBuildContext): Promise<CodeBuildResult> {
		const sources = selectSources(context.spec, context.explicitSources);
		const entry = context.spec.resources.find(resource => resource.id === context.spec.target.entryResourceId)!;
		const found = await discoverPython(candidatesFor(context.toolchainCandidates), context.run, context.directory, context.signal);
		if (found.cancelled) {
			return { toolchainLabel: "", phase: { kind: "preparation", status: "cancelled", exitCode: null, stdout: "", stderr: "Check cancelled." }, diagnostics: [] };
		}
		if (!found.interpreter) {
			return { toolchainLabel: "", phase: { kind: "preparation", status: "unavailable", exitCode: null, stdout: "", stderr: found.message }, diagnostics: [], unavailableMessage: found.message };
		}
		const interpreter = found.interpreter;
		const label = `${describe(interpreter)} ${interpreter.version}`;
		const run = await context.run(interpreter.command, [...interpreter.args, ...HELPER_FLAGS, "-c", HELPER, ...sources], context.directory, "", context.timeoutMs, context.signal);
		const base = { toolchain: { id: describe(interpreter), version: interpreter.version }, toolchainLabel: label };
		if (run.cancelled || run.timedOut) {
			return { ...base, phase: { kind: "preparation", status: run.cancelled ? "cancelled" : "timeout", exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr }, diagnostics: [] };
		}
		const entries = parseHelper(run.stdout);
		const checked = entries ? syntaxDiagnostics(context.spec, entries) : { diagnostics: [], text: "" };
		const clean = run.exitCode === 0 && entries !== undefined && entries.length === sources.length && !entries.some(entry => entry.error);
		// Unparseable helper output is preserved raw rather than hidden.
		const phase: ExecutionPhase = clean
			? { kind: "preparation", status: "passed", exitCode: 0, stdout: "", stderr: run.stderr }
			: { kind: "preparation", status: "failed", exitCode: run.exitCode, stdout: entries ? "" : run.stdout, stderr: [checked.text, run.stderr].filter(Boolean).join("\n") };
		return clean
			? { ...base, phase, diagnostics: [], program: { command: interpreter.command, args: [...interpreter.args, ...RUN_FLAGS, entry.path] } }
			: { ...base, phase, diagnostics: checked.diagnostics };
	},

	executionDiagnostics: ({ directory, spec, stderr }) => tracebackDiagnostics(spec, directory, stderr),
};
