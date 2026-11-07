import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodeActivitySpec, CodeDiagnostic, CodeDiagnosticRange, CodeResource, ExecutionPhase } from "../core/code-activity.ts";
import type { CodeProfileReadiness } from "../core/code-readiness.ts";
import type { CodeBuildContext, CodeBuildResult, CodeExecutionProvider } from "./code-provider.ts";
import { DEFAULT_PATH, runProcess } from "./code-process.ts";

/** Rust 2021 shipped with Rust 1.56. */
const MINIMUM = { major: 1, minor: 56 };
const MISSING_ADVICE = "Install Rust 1.56 or newer (rustup.rs or your package manager) so `rustc` is on your PATH, then check again. Nothing is installed or updated for you.";
const PROXY_ADVICE = "`rustc` is a rustup shim, but rustup could not resolve an installed toolchain. Run `rustup default stable` (or `rustup toolchain install stable`) yourself, then check again. Nothing is installed or updated for you.";
/** Hidden so it can never collide with a workspace resource path (those start with a letter, digit, or underscore). */
const EXECUTABLE = `.learnharness-solution${process.platform === "win32" ? ".exe" : ""}`;
const exeName = (name: string) => process.platform === "win32" ? `${name}.exe` : name;

export interface RustCompiler { command: string; version: string; host?: string; }
export type RustDiscovery =
	| { compiler: RustCompiler; message?: undefined; cancelled?: undefined }
	| { compiler?: undefined; message: string; cancelled?: undefined }
	/** The caller cancelled while discovering: not a missing compiler. */
	| { compiler?: undefined; message?: undefined; cancelled: true };

type Runner = CodeBuildContext["run"];

const isExecutableFile = (file: string): boolean => {
	try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
};
const realPath = (file: string): string => { try { return fs.realpathSync(file); } catch { return file; } };

/** A rustup proxy is a link to the `rustup` binary that picks a toolchain from the current
 *  directory and environment, and may download one. It is never run, only resolved. */
function isRustupProxy(file: string): boolean {
	if (path.basename(realPath(file)).replace(/\.exe$/i, "").toLowerCase() === "rustup") return true;
	const sibling = path.join(path.dirname(file), exeName("rustup"));
	// Windows proxies are copies, not links: they sit beside the real rustup.exe.
	if (process.platform === "win32") return isExecutableFile(sibling);
	// Unix proxies may be hardlinks of the sibling rustup (same device and inode), not symlinks.
	try {
		const candidate = fs.statSync(file);
		const rustup = fs.statSync(sibling);
		return candidate.dev === rustup.dev && candidate.ino === rustup.ino;
	} catch { return false; }
}

/** Absolute, existing, executable candidates in order. PATH entries must be absolute and a
 *  relative candidate is never probed, so nothing learner-authored (or cwd-relative) is found.
 *  Without an explicit list, the standard rustup location is tried last because a desktop app
 *  often starts with a PATH that omits it. */
function locate(explicit?: string[]): string[] {
	const found: string[] = [];
	for (const name of explicit ?? ["rustc"]) {
		if (path.isAbsolute(name)) { found.push(name); continue; }
		if (/[\\/]/.test(name)) continue;
		for (const directory of (process.env.PATH || DEFAULT_PATH).split(path.delimiter)) {
			if (path.isAbsolute(directory)) found.push(path.join(directory, name === "rustc" ? exeName(name) : name));
		}
	}
	if (!explicit) found.push(path.join(process.env.CARGO_HOME || path.join(os.homedir(), ".cargo"), "bin", exeName("rustc")));
	return [...new Set(found)].filter(isExecutableFile);
}

/** Environment for the one trusted metadata query, `rustup which rustc`. It reads the real
 *  home's toolchain metadata and nothing else, and it cannot download: auto-install is off and
 *  the distribution server points at a discard port. Never used for builds or learner programs. */
function rustupEnvironment(): NodeJS.ProcessEnv {
	const home = os.homedir();
	const dead = "http://127.0.0.1:9";
	const inherited = (["RUSTUP_HOME", "CARGO_HOME", "RUSTUP_TOOLCHAIN"] as const).flatMap(name => process.env[name] ? [[name, process.env[name]] as const] : []);
	return {
		PATH: process.env.PATH || DEFAULT_PATH,
		NODE_ENV: "production", HOME: home, TMPDIR: os.tmpdir(), LANG: "C", LC_ALL: "C",
		RUSTUP_AUTO_INSTALL: "0", RUSTUP_DIST_SERVER: dead, RUSTUP_UPDATE_ROOT: dead,
		...Object.fromEntries(inherited),
		...(process.platform === "win32" ? { USERPROFILE: home, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
	};
}

/** Resolve a proxy to the compiler it currently selects, or nothing when rustup has none. */
async function resolveProxy(proxy: string, run: Runner, scratch: string, signal?: AbortSignal): Promise<{ command?: string; cancelled?: true }> {
	const sibling = path.join(path.dirname(proxy), exeName("rustup"));
	const rustup = isExecutableFile(sibling) ? sibling : realPath(proxy);
	const result = await run(rustup, ["which", "rustc"], scratch, "", 10_000, signal, rustupEnvironment());
	if (result.cancelled) return { cancelled: true };
	if (result.unavailable || result.timedOut || result.exitCode !== 0) return {};
	const target = result.stdout.split(/\r?\n/)[0]?.trim() ?? "";
	return path.isAbsolute(target) && isExecutableFile(target) && !isRustupProxy(target) ? { command: target } : {};
}

/** Find an installed compiler and verify its ACTUAL version under the same sanitized
 *  environment learner builds use. Probing happens in an empty private directory, never the
 *  workspace, so learner-authored files (rust-toolchain.toml, config) cannot steer discovery. */
export async function discoverRust(explicit: string[] | undefined, run: Runner, signal?: AbortSignal): Promise<RustDiscovery> {
	// Cancellation wins even when there is nothing to probe.
	if (signal?.aborted) return { cancelled: true };
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "learnharness-rustc-"));
	try {
		let older: string | undefined;
		let unresolvedProxy = false;
		const triedProxies = new Set<string>();
		for (const candidate of locate(explicit)) {
			if (signal?.aborted) return { cancelled: true };
			let command = candidate;
			if (isRustupProxy(candidate)) {
				const key = realPath(candidate);
				if (triedProxies.has(key)) continue;
				triedProxies.add(key);
				const resolved = await resolveProxy(candidate, run, scratch, signal);
				if (resolved.cancelled) return { cancelled: true };
				if (!resolved.command) { unresolvedProxy = true; continue; }
				command = resolved.command;
			}
			const probe = await run(command, ["--version", "--verbose"], scratch, "", 10_000, signal);
			if (probe.cancelled) return { cancelled: true };
			if (probe.unavailable || probe.exitCode !== 0 || probe.timedOut) continue;
			const version = /^release:\s*(\d+)\.(\d+)\.(\d+)/m.exec(probe.stdout);
			if (!/^rustc /.test(probe.stdout) || !version) continue;
			const text = `${version[1]}.${version[2]}.${version[3]}`;
			const host = /^host:\s*(\S+)/m.exec(probe.stdout)?.[1];
			if (Number(version[1]) > MINIMUM.major || Number(version[1]) === MINIMUM.major && Number(version[2]) >= MINIMUM.minor) {
				return { compiler: { command, version: text, ...(host ? { host } : {}) } };
			}
			older ??= `rustc ${text}`;
		}
		return { message: older
			? `Rust 1.56 or newer is required for the 2021 edition, but only ${older} was found. ${MISSING_ADVICE}`
			: unresolvedProxy ? PROXY_ADVICE : `Rust 1.56 or newer was not found. ${MISSING_ADVICE}` };
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/** Only the crate root is compiled; supporting modules are reached through `mod` declarations. */
function selectSources(spec: CodeActivitySpec, explicit?: string[]): string[] {
	if (explicit) throw new Error("Invalid compilation sources.");
	return [spec.resources.find(resource => resource.id === spec.target.entryResourceId)!.path];
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** rustc reports a file as it was given or found (relative to the crate directory); anything
 *  absolute outside the workspace, or not a resource, is not attributed. */
function resourceFor(spec: CodeActivitySpec, directory: string, file: string): CodeResource | undefined {
	const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
	const roots = [directory, realPath(directory)].map(root => `${root.replace(/\\/g, "/").replace(/\/$/, "")}/`);
	const prefix = roots.find(root => normalized.startsWith(root));
	const relative = prefix ? normalized.slice(prefix.length) : /^(?:[A-Za-z]:)?\//.test(normalized) ? undefined : normalized;
	return relative === undefined ? undefined : spec.resources.find(resource => resource.path === relative);
}

/** Lines as rustc numbers them (`\n` only, CR stripped), or undefined when line numbers could
 *  disagree with the editor's (a lone CR is a line break there but not for rustc). */
function sourceLines(content: string): string[] | undefined {
	if (/\r(?!\n)/.test(content)) return undefined;
	return content.split("\n").map(line => line.replace(/\r$/, ""));
}

/** rustc columns are 1-based Unicode scalar offsets; the editor counts UTF-16 units. Convert from
 *  the original line, or return undefined when the position cannot be trusted. */
function editorColumn(lines: string[], line: number, offset: unknown, bom: boolean): number | undefined {
	if (!positive(offset) || line > lines.length || line === 1 && bom) return undefined;
	const points = Array.from(lines[line - 1]!);
	if (offset > points.length + 1) return undefined;
	return points.slice(0, offset - 1).join("").length + 1;
}

interface JsonSpan { file_name: string; line_start: number; line_end: number; column_start: number; column_end: number; is_primary: boolean; label: string | null; expansion?: { span?: JsonSpan } | null; }
interface JsonDiagnostic { message: string; code?: { code?: string } | null; level: string; spans: JsonSpan[]; children?: { message?: string; level?: string }[]; rendered?: string | null; }

function parseJsonLine(line: string): JsonDiagnostic | undefined {
	if (!line.startsWith("{")) return undefined;
	try {
		const value = JSON.parse(line) as Partial<JsonDiagnostic>;
		return typeof value.message === "string" && typeof value.level === "string" && Array.isArray(value.spans) ? value as JsonDiagnostic : undefined;
	} catch { return undefined; }
}

/** The primary span in a workspace file. A span inside a macro expansion (e.g. `println!`) that
 *  lies in the standard library is followed outward to the call site in the learner's code. */
function workspaceSpan(spec: CodeActivitySpec, directory: string, diagnostic: JsonDiagnostic): { resource: CodeResource; span: JsonSpan } | undefined {
	let span: JsonSpan | undefined | null = diagnostic.spans.find(item => item.is_primary);
	for (let depth = 0; span && depth < 16; depth++) {
		const resource = typeof span.file_name === "string" ? resourceFor(spec, directory, span.file_name) : undefined;
		if (resource) return { resource, span };
		span = span.expansion?.span;
	}
	return undefined;
}

function rangeOf(resource: CodeResource, span: JsonSpan): CodeDiagnosticRange | undefined {
	const lines = sourceLines(resource.content);
	if (!lines || !positive(span.line_start) || span.line_start > lines.length) return undefined;
	const bom = resource.content.startsWith("﻿");
	const line = span.line_start;
	const column = editorColumn(lines, line, span.column_start, bom);
	if (column === undefined) return { line };
	const endLine = positive(span.line_end) && span.line_end <= lines.length ? span.line_end : line;
	const endColumn = editorColumn(lines, endLine, span.column_end, bom);
	return {
		line, column,
		...(endLine !== line ? { endLine } : {}),
		...(endColumn !== undefined && (endLine !== line || endColumn > column) ? { endColumn } : {}),
	};
}

const MESSAGE_LIMIT = 2000;
const DIAGNOSTIC_LIMIT = 50;

function toDiagnostic(spec: CodeActivitySpec, directory: string, item: JsonDiagnostic): CodeDiagnostic | undefined {
	const located = workspaceSpan(spec, directory, item);
	if (!located) return undefined;
	const code = item.code?.code;
	const label = located.span.label;
	const notes = (item.children ?? []).filter(child => typeof child.message === "string" && (child.level === "note" || child.level === "help")).slice(0, 4).map(child => `${child.level}: ${child.message}`);
	const headline = `${code ? `${code}: ` : ""}${item.message}${label && label !== item.message ? ` (${label})` : ""}`;
	const range = rangeOf(located.resource, located.span);
	return {
		resourceId: located.resource.id, path: located.resource.path, ...(range ? { range } : {}),
		severity: item.level === "warning" ? "warning" : item.level.startsWith("error") ? "error" : "info",
		message: [headline, ...notes].join("\n").slice(0, MESSAGE_LIMIT),
		source: "rustc",
	};
}

/** Split rustc's JSON-lines stderr into human-readable text (the compiler's own rendering, plus
 *  any line that is not a diagnostic) and structured diagnostics for workspace files only. */
function parseCompilerOutput(spec: CodeActivitySpec, directory: string, stderr: string, truncated: boolean): { text: string; diagnostics: CodeDiagnostic[] } {
	const text: string[] = [];
	const diagnostics: CodeDiagnostic[] = [];
	const seen = new Set<string>();
	for (const line of stderr.split(/\r?\n/)) {
		const item = parseJsonLine(line);
		if (!item) {
			// A JSON line cut short by the output limit is noise, not compiler text.
			if (line.trim() && !(truncated && line.startsWith("{"))) text.push(line);
			continue;
		}
		text.push((item.rendered ?? `${item.level}: ${item.message}`).trimEnd());
		const diagnostic = toDiagnostic(spec, directory, item);
		const key = diagnostic && JSON.stringify(diagnostic);
		if (diagnostic && !seen.has(key!) && diagnostics.length < DIAGNOSTIC_LIMIT) { seen.add(key!); diagnostics.push(diagnostic); }
	}
	return { text: text.join("\n"), diagnostics };
}

/** Panics print `thread 'main' (id) panicked at file:line:col:` then the message (older compilers:
 *  `panicked at 'message', file:line:col`). Only locations inside workspace files are mapped,
 *  to the line: a panic column is not a trustworthy editor position. */
function panicDiagnostics(spec: CodeActivitySpec, directory: string, stderr: string): CodeDiagnostic[] {
	const lines = stderr.split(/\r?\n/);
	const diagnostics: CodeDiagnostic[] = [];
	lines.forEach((text, index) => {
		const current = /^thread '[^']*'(?: \(\d+\))? panicked at (.+?):(\d+):(\d+):$/.exec(text);
		const legacy = current ? undefined : /^thread '[^']*' panicked at '(.*)', (.+?):(\d+):(\d+)$/.exec(text);
		if (!current && !legacy) return;
		const [file, line] = current ? [current[1]!, Number(current[2])] : [legacy![2]!, Number(legacy![3])];
		let end = index + 1;
		while (end < lines.length && !/^(?:note: |stack backtrace:|thread ')/.test(lines[end]!)) end++;
		const detail = (current ? lines.slice(index + 1, end).join("\n") : legacy![1]!).trim();
		const resource = resourceFor(spec, directory, file);
		if (!resource || !positive(line) || diagnostics.length >= 5) return;
		diagnostics.push({ resourceId: resource.id, path: resource.path, range: { line }, severity: "error", message: detail ? `Panic: ${detail}` : "The program panicked.", source: "rust" });
	});
	return diagnostics;
}

/** Trusted Rust provider: discovered compiler, fixed rustc argv, structured diagnostics, panic mapping. */
export const rustProvider: CodeExecutionProvider = {
	profileId: "rust2021-stdio",

	async readiness(): Promise<CodeProfileReadiness> {
		const found = await discoverRust(undefined, runProcess);
		return found.compiler
			? { profileId: this.profileId, state: "ready", toolchain: { id: "rustc", version: found.compiler.version } }
			: { profileId: this.profileId, state: "unavailable", message: found.message };
	},

	// No Cargo manifest or editor scaffold: the program is one rustc invocation.
	scaffoldFiles: () => [],

	buildSources: selectSources,

	async build(context: CodeBuildContext): Promise<CodeBuildResult> {
		const [entry] = selectSources(context.spec, context.explicitSources);
		const found = await discoverRust(context.toolchainCandidates, context.run, context.signal);
		if (found.cancelled) {
			return { toolchainLabel: "", phase: { kind: "build", status: "cancelled", exitCode: null, stdout: "", stderr: "Check cancelled." }, diagnostics: [] };
		}
		if (!found.compiler) {
			return { toolchainLabel: "", phase: { kind: "build", status: "unavailable", exitCode: null, stdout: "", stderr: found.message }, diagnostics: [], unavailableMessage: found.message };
		}
		const compiler = found.compiler;
		const executable = path.join(context.directory, EXECUTABLE);
		const args = ["--edition=2021", "--crate-name", "solution", "--crate-type", "bin", "--error-format=json", "-o", executable, entry!];
		const compilation = await context.run(compiler.command, args, context.directory, "", context.timeoutMs, context.signal);
		const base = { toolchain: { id: "rustc", version: compiler.version }, toolchainLabel: `rustc ${compiler.version} --edition=2021` };
		// The output cap is decided before the exit code: a compiler that exited 0 just as it was
		// stopped has still produced truncated output, and no program is returned.
		const status: ExecutionPhase["status"] = compilation.cancelled ? "cancelled" : compilation.timedOut ? "timeout" : compilation.outputLimited ? "output_limit" : compilation.exitCode === 0 ? "passed" : "failed";
		const output = parseCompilerOutput(context.spec, context.directory, compilation.stderr, compilation.outputLimited);
		const phase: ExecutionPhase = { kind: "build", status, exitCode: compilation.exitCode, stdout: compilation.stdout, stderr: output.text };
		return status === "passed" ? { ...base, phase, diagnostics: output.diagnostics, program: { command: executable, args: [] } } : { ...base, phase, diagnostics: output.diagnostics };
	},

	executionDiagnostics: ({ directory, spec, stderr }) => panicDiagnostics(spec, directory, stderr),
};
