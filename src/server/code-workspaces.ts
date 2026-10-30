import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { CODE_DEMO_EXERCISE, CODE_SOURCE_LIMIT, parseCodeExercise, type CodeExercise, type CodeRunResult, type CodeWorkspaceView } from "../core/code-workspace.ts";
import { activeProblemOf } from "../core/native-messages.ts";
import { chatStore } from "../store/chats.ts";
import { codeFilename, runCodeExercise } from "./code-runner.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

export class CodeWorkspaceError extends Error {
	constructor(message: string, readonly status = 400) { super(message); }
}
export type CodeEditor = "vscode" | "cursor" | "default";
export interface CodeWorkspaceCommand {
	action: "load" | "save" | "check" | "open";
	chatId: string;
	problemCallId: string;
	source?: string;
	expectedRevision?: string;
	editor?: CodeEditor;
}
interface Metadata { id: string; chatId: string; problemCallId: string; exerciseHash: string; lastRunId?: string; }
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const validId = (id: string) => /^[A-Za-z0-9_-]{1,200}$/.test(id);

function mkdir(directory: string) {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (!fs.lstatSync(directory).isDirectory()) throw new CodeWorkspaceError("The workspace directory is not a regular directory.", 409);
}
function safeRead(file: string, limit: number): string {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new CodeWorkspaceError("The workspace file is not a regular file or exceeds its size limit.", 409);
		// Bound the actual read too: an external editor can grow a file after fstat.
		const buffer = Buffer.alloc(limit + 1);
		let total = 0;
		while (total <= limit) {
			const count = fs.readSync(fd, buffer, total, buffer.length - total, null);
			if (count === 0) break;
			total += count;
		}
		if (total > limit) throw new CodeWorkspaceError("The workspace file exceeds its size limit.", 409);
		return buffer.subarray(0, total).toString("utf8");
	} finally { fs.closeSync(fd); }
}
function writeAtomic(file: string, text: string) {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
		fs.renameSync(temporary, file);
	} finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function activeExercise(chatId: string, problemCallId: string): CodeExercise {
	if (chatId === "demo" && problemCallId === "cpp-sum") return CODE_DEMO_EXERCISE;
	const chat = chatStore.getChat(chatId);
	if (!chat) throw new CodeWorkspaceError("This chat no longer exists.", 404);
	const problem = activeProblemOf(chat.messages);
	if (!problem || problem.toolCallId !== problemCallId) throw new CodeWorkspaceError("This code exercise is no longer the active problem.", 409);
	return parseCodeExercise((problem.input as { codeExercise?: unknown })?.codeExercise);
}

function executableInPath(name: string): string | undefined {
	for (const directory of (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(path.delimiter)) {
		if (!path.isAbsolute(directory)) continue;
		const candidate = path.join(directory, name);
		try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* Try next PATH entry. */ }
	}
	return undefined;
}

/** Only explicit UI operations reach this allowlist. There is no command-string API. */
export async function openCodeEditor(file: string, editor: CodeEditor): Promise<void> {
	const editorEnv: NodeJS.ProcessEnv = { NODE_ENV: "production" };
	for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "USERPROFILE", "SystemRoot", "WINDIR", "APPDATA", "LOCALAPPDATA", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL"]) {
		if (process.env[key] !== undefined) editorEnv[key] = process.env[key];
	}
	let command: string | undefined;
	let args: string[];
	if (editor === "default") {
		command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "notepad.exe" : executableInPath("xdg-open");
		args = process.platform === "darwin" ? ["-t", file] : [file];
	} else {
		const binary = editor === "vscode" ? "code" : "cursor";
		command = executableInPath(binary);
		if (!command && process.platform === "darwin") {
			const app = editor === "vscode" ? "Visual Studio Code.app" : "Cursor.app";
			const bundled = path.join("/Applications", app, "Contents/Resources/app/bin", binary);
			if (fs.existsSync(bundled)) command = bundled;
		}
		args = ["--new-window", path.dirname(file), "--goto", `${file}:1`];
	}
	if (!command) throw new CodeWorkspaceError(`The selected editor was not found. Install its command-line launcher or choose Default editor.`, 422);
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command!, args, { env: editorEnv, shell: false, detached: true, stdio: "ignore", windowsHide: true });
		child.once("error", () => reject(new CodeWorkspaceError("The editor could not be opened. Check that it is installed or choose Default editor.", 422)));
		child.once("spawn", () => { child.unref(); resolve(); });
	});
}

export function createCodeWorkspaceService(options: {
	directory: string;
	getExercise: (chatId: string, problemCallId: string) => CodeExercise;
	runner?: typeof runCodeExercise;
	openEditor?: typeof openCodeEditor;
}) {
	const running = new Set<string>();
	function files(chatId: string, problemCallId: string) {
		if (!validId(chatId) || !validId(problemCallId)) throw new CodeWorkspaceError("Invalid chat or problem identifier.");
		const exercise = parseCodeExercise(options.getExercise(chatId, problemCallId));
		const exerciseHash = digest(JSON.stringify(exercise));
		// Providers can reuse tool-call IDs. A changed exercise gets a fresh directory.
		const id = digest(`${chatId}\0${problemCallId}\0${exerciseHash}`);
		const directory = path.join(options.directory, id);
		mkdir(options.directory);
		mkdir(directory);
		const metadataFile = path.join(directory, "workspace.json");
		const sourceFile = path.join(directory, codeFilename(exercise.language));
		let metadata: Metadata;
		if (!fs.existsSync(metadataFile)) {
			metadata = { id, chatId, problemCallId, exerciseHash };
			// Exclusive creation never overwrites an externally edited answer.
			if (!fs.existsSync(sourceFile)) fs.writeFileSync(sourceFile, exercise.starterCode, { encoding: "utf8", mode: 0o600, flag: "wx" });
			const flagsFile = path.join(directory, "compile_flags.txt");
			if (!fs.existsSync(flagsFile)) fs.writeFileSync(flagsFile, "-std=c++20\n-Wall\n-Wextra\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
			writeAtomic(metadataFile, JSON.stringify(metadata));
		} else {
			metadata = JSON.parse(safeRead(metadataFile, 16 * 1024)) as Metadata;
			if (metadata.id !== id || metadata.chatId !== chatId || metadata.problemCallId !== problemCallId || metadata.exerciseHash !== exerciseHash) throw new CodeWorkspaceError("The exercise changed. Start a new code problem before creating another workspace.", 409);
		}
		return { id, directory, metadataFile, sourceFile, metadata, exercise };
	}
	function readRun(state: ReturnType<typeof files>, runId: string): CodeRunResult {
		if (!/^[0-9a-f-]{36}$/.test(runId)) throw new CodeWorkspaceError("Invalid code check identifier.");
		const run = JSON.parse(safeRead(path.join(state.directory, `${runId}.json`), 2 * 1024 * 1024)) as CodeRunResult;
		if (run.id !== runId || run.workspaceId !== state.id || typeof run.source !== "string" || digest(run.source) !== run.revision || run.language !== state.exercise.language) throw new CodeWorkspaceError("The saved check does not match this exercise.", 409);
		return run;
	}
	function view(state: ReturnType<typeof files>): CodeWorkspaceView {
		const source = safeRead(state.sourceFile, CODE_SOURCE_LIMIT);
		return { id: state.id, language: state.exercise.language, filename: path.basename(state.sourceFile), source, revision: digest(source), path: state.sourceFile, tests: state.exercise.tests, ...(state.metadata.lastRunId ? { lastRun: readRun(state, state.metadata.lastRunId) } : {}) };
	}
	async function execute(command: CodeWorkspaceCommand, signal?: AbortSignal): Promise<CodeWorkspaceView> {
		const state = files(command.chatId, command.problemCallId);
		if (command.action === "load") return view(state);
		if (command.action === "save") {
			if (typeof command.source !== "string" || Buffer.byteLength(command.source, "utf8") > CODE_SOURCE_LIMIT) throw new CodeWorkspaceError("The source file must be at most 64 KiB.");
			const current = view(state);
			if (command.expectedRevision !== current.revision) throw new CodeWorkspaceError("The file changed in another editor. Reload the saved file before saving your draft.", 409);
			writeAtomic(state.sourceFile, command.source);
			return view(state);
		}
		if (command.action === "open") {
			const current = view(state);
			await (options.openEditor ?? openCodeEditor)(current.path, command.editor ?? "default");
			return current;
		}
		if (command.action !== "check") throw new CodeWorkspaceError("Unknown workspace action.");
		if (running.has(state.id) || running.size >= 2) throw new CodeWorkspaceError("A code check is already running. Wait for it to finish.", 409);
		const current = view(state);
		if (command.expectedRevision && command.expectedRevision !== current.revision) throw new CodeWorkspaceError("The saved file changed. Reload it before checking.", 409);
		running.add(state.id);
		try {
			const run = await (options.runner ?? runCodeExercise)({ workspaceId: state.id, source: current.source, revision: current.revision, exercise: state.exercise }, { signal });
			// Re-resolve active ownership and directory safety after the asynchronous run.
			const latest = files(command.chatId, command.problemCallId);
			if (latest.id !== state.id) throw new CodeWorkspaceError("The active exercise changed while this check was running. Check the new exercise instead.", 409);
			writeAtomic(path.join(latest.directory, `${run.id}.json`), JSON.stringify(run));
			latest.metadata.lastRunId = run.id;
			writeAtomic(latest.metadataFile, JSON.stringify(latest.metadata));
			return view(latest);
		} finally { running.delete(state.id); }
	}
	function getRunForSubmission(chatId: string, problemCallId: string, runId: string): CodeRunResult {
		const state = files(chatId, problemCallId);
		const run = readRun(state, runId);
		if (digest(safeRead(state.sourceFile, CODE_SOURCE_LIMIT)) !== run.revision) throw new CodeWorkspaceError("The source changed since this check. Check the saved file again before submitting.", 409);
		return run;
	}
	return { execute, getRunForSubmission };
}

const serviceKey = Symbol.for("learnharness.code-workspaces");
const globals = globalThis as typeof globalThis & { [serviceKey]?: ReturnType<typeof createCodeWorkspaceService> };
const service = globals[serviceKey] ??= createCodeWorkspaceService({ directory: path.join(PATHS.data, "code-workspaces"), getExercise: activeExercise });
export const getCodeRunForSubmission = service.getRunForSubmission;
export const resolveCodeSubmission = getCodeRunForSubmission;

/** Local host AND local Origin are required, including for the demo workspace. */
export function codeWorkspaceRequestAuthorized(request: Request): boolean {
	try {
		const url = new URL(request.url);
		const host = request.headers.get("host") ?? url.host;
		const addressed = new URL(`${url.protocol}//${host}`);
		const origin = new URL(request.headers.get("origin") ?? "");
		const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
		if (!loopback(addressed.hostname) || !loopback(origin.hostname) || !["http:", "https:"].includes(addressed.protocol) || addressed.origin !== origin.origin || origin.href !== `${origin.origin}/` || addressed.href !== `${addressed.origin}/`) return false;
		if (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return false;
		return desktopAPIAuthorized(request.headers);
	} catch { return false; }
}

export async function codeWorkspacesResponse(request: Request): Promise<Response> {
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	const error = (message: string, status: number) => Response.json({ error: message }, { status, headers });
	if (!codeWorkspaceRequestAuthorized(request)) return error("Code workspaces require the local LearnHarness window.", 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error("Expected a JSON workspace action.", 415);
	try {
		const raw = await readBoundedJson(request, 128 * 1024);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CodeWorkspaceError("Invalid workspace action.");
		const command = raw as Record<string, unknown>;
		if (!["load", "save", "check", "open"].includes(String(command.action)) || typeof command.chatId !== "string" || typeof command.problemCallId !== "string") throw new CodeWorkspaceError("Invalid workspace action or identifiers.");
		if (command.editor !== undefined && !["vscode", "cursor", "default"].includes(String(command.editor))) throw new CodeWorkspaceError("Choose VS Code, Cursor, or Default editor.");
		if (command.source !== undefined && typeof command.source !== "string" || command.expectedRevision !== undefined && typeof command.expectedRevision !== "string") throw new CodeWorkspaceError("Invalid source or revision.");
		return Response.json(await service.execute(command as unknown as CodeWorkspaceCommand, request.signal), { headers });
	} catch (err) {
		if (err instanceof CodeWorkspaceError) return error(err.message, err.status);
		if (err instanceof CustomBodyLimitError) return error("Workspace request is too large.", 413);
		if (err instanceof SyntaxError) return error("Invalid workspace data.", 400);
		const fsError = err as NodeJS.ErrnoException;
		if (["ELOOP", "ENOENT", "EEXIST", "ENOTDIR"].includes(fsError.code ?? "")) return error("A workspace file was moved or replaced. Restore the original file and reload.", 409);
		return error(err instanceof Error ? err.message : "The code workspace could not be opened.", 400);
	}
}
