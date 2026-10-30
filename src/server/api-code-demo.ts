import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { API_DEMO_FILES, API_DEMO_STARTER, API_DEMO_TESTS, API_DEMO_VERSION, type ApiDemoFile, type ApiDemoRun, type ApiDemoWorkspace } from "../core/api-code-demo.ts";
import { CODE_SOURCE_LIMIT, CODE_TEST_TEXT_LIMIT, type CodeRunResult } from "../core/code-workspace.ts";
import { runCodeExercise, runCodeProgram, type CodeRunnerInput } from "./code-runner.ts";
import { codeWorkspaceRequestAuthorized, CodeWorkspaceError, openCodeEditor, type CodeEditor } from "./code-workspaces.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

const BUILD = { profile: "cpp20-library-v1", sources: ["solution.cpp", "library_api.cpp", "main.cpp"], flags: ["-std=c++20", "-Wall", "-Wextra", "-pedantic", "-O0", "-I."] };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MANIFEST = hash({ storageLayout: 2, version: API_DEMO_VERSION, files: API_DEMO_FILES, tests: API_DEMO_TESTS, build: BUILD });
interface Metadata { manifest: string; lastRunId?: string; lastCheckId?: string; }
interface Snapshot { version: string; manifest: string; files: ApiDemoFile[]; tests: typeof API_DEMO_TESTS; build: typeof BUILD; }
type SavedResult = { kind: "run"; result: ApiDemoRun; snapshot: Snapshot } | { kind: "check"; result: CodeRunResult; snapshot: Snapshot };
export interface ApiCodeDemoCommand {
	action: "load" | "save" | "run" | "check" | "open";
	source?: string;
	expectedRevision?: string;
	stdin?: string;
	editor?: CodeEditor;
}

function ensureDirectory(directory: string) {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (!fs.lstatSync(directory).isDirectory()) throw new CodeWorkspaceError("The API demo directory was replaced. Restore it before continuing.", 409);
}
function readFile(file: string, limit: number): string {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new CodeWorkspaceError("A demo file is not a regular file or exceeds its size limit.", 409);
		const buffer = Buffer.alloc(limit + 1);
		let size = 0;
		while (size <= limit) {
			const read = fs.readSync(fd, buffer, size, buffer.length - size, null);
			if (!read) break;
			size += read;
		}
		if (size > limit) throw new CodeWorkspaceError("A demo file exceeds its size limit.", 409);
		return buffer.subarray(0, size).toString("utf8");
	} finally { fs.closeSync(fd); }
}
function saveFile(file: string, text: string) {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
		fs.renameSync(temporary, file);
	} finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function createApiCodeDemoService(options: {
	directory: string;
	check?: typeof runCodeExercise;
	run?: typeof runCodeProgram;
	openEditor?: typeof openCodeEditor;
}) {
	let busy = false;
	const directory = path.join(options.directory, `${API_DEMO_VERSION}-${MANIFEST.slice(0, 12)}`);
	const projectDirectory = path.join(directory, "project");
	const metadataFile = path.join(directory, "workspace.json");
	function workspace(): { metadata: Metadata; snapshot: Snapshot; revision: string } {
		ensureDirectory(options.directory);
		ensureDirectory(directory);
		ensureDirectory(projectDirectory);
		let metadata: Metadata;
		if (fs.existsSync(metadataFile)) {
			metadata = JSON.parse(readFile(metadataFile, 16 * 1024)) as Metadata;
			if (metadata.manifest !== MANIFEST) throw new CodeWorkspaceError("The demo setup changed. Open the current example to create a fresh workspace.", 409);
		} else {
			// Recover interrupted initial setup without replacing any learner edits.
			for (const file of API_DEMO_FILES) {
				const target = path.join(projectDirectory, file.path);
				if (!fs.existsSync(target)) fs.writeFileSync(target, file.source, { encoding: "utf8", mode: 0o600, flag: "wx" });
			}
			metadata = { manifest: MANIFEST };
			saveFile(metadataFile, JSON.stringify(metadata));
		}
		const files = API_DEMO_FILES.map((file) => {
			const source = readFile(path.join(projectDirectory, file.path), CODE_SOURCE_LIMIT);
			if (file.role !== "learner" && source !== file.source) throw new CodeWorkspaceError(`Supporting file ${file.path} changed. Restore its supplied contents before running or checking this exercise. Your solution has been preserved.`, 409);
			return { ...file, source };
		});
		const snapshot: Snapshot = { version: API_DEMO_VERSION, manifest: MANIFEST, files, tests: API_DEMO_TESTS, build: BUILD };
		return { metadata, snapshot, revision: hash(snapshot) };
	}
	function readResult(id: string, kind: "run" | "check"): SavedResult {
		if (!/^[0-9a-f-]{36}$/.test(id)) throw new CodeWorkspaceError("Invalid saved run identifier.", 409);
		const saved = JSON.parse(readFile(path.join(directory, `${id}.json`), 2 * 1024 * 1024)) as SavedResult;
		if (saved.kind !== kind || saved.result.id !== id || saved.snapshot.manifest !== MANIFEST || hash(saved.snapshot) !== saved.result.revision || saved.snapshot.files.find((file) => file.path === "solution.cpp")?.source !== saved.result.source) throw new CodeWorkspaceError("The saved result does not match its project snapshot.", 409);
		return saved;
	}
	function view(state = workspace()): ApiDemoWorkspace {
		const source = state.snapshot.files.find((file) => file.role === "learner")!.source;
		return {
				source, revision: state.revision, path: path.join(projectDirectory, "solution.cpp"), files: state.snapshot.files,
			...(state.metadata.lastRunId ? { lastRun: readResult(state.metadata.lastRunId, "run").result as ApiDemoRun } : {}),
			...(state.metadata.lastCheckId ? { lastCheck: readResult(state.metadata.lastCheckId, "check").result as CodeRunResult } : {}),
		};
	}
	async function execute(command: ApiCodeDemoCommand, signal?: AbortSignal): Promise<ApiDemoWorkspace> {
		const state = workspace();
		if (command.action === "load") return view(state);
		if (command.action === "save") {
			if (typeof command.source !== "string" || Buffer.byteLength(command.source, "utf8") > CODE_SOURCE_LIMIT) throw new CodeWorkspaceError("Your source must be at most 64 KiB.");
			if (command.expectedRevision !== state.revision) throw new CodeWorkspaceError("The project changed in another editor. Reload saved files before saving this draft.", 409);
			saveFile(path.join(projectDirectory, "solution.cpp"), command.source);
			return view();
		}
		if (command.action === "open") {
			const current = view(state);
			await (options.openEditor ?? openCodeEditor)(current.path, command.editor ?? "default");
			return current;
		}
		if (command.action !== "run" && command.action !== "check") throw new CodeWorkspaceError("Unknown API demo action.");
		if (busy) throw new CodeWorkspaceError("This project is already running. Wait for it to finish.", 409);
		if (command.expectedRevision && command.expectedRevision !== state.revision) throw new CodeWorkspaceError("The saved project changed. Reload it before running.", 409);
		if (command.action === "run" && (typeof command.stdin !== "string" || Buffer.byteLength(command.stdin, "utf8") > CODE_TEST_TEXT_LIMIT)) throw new CodeWorkspaceError("Run input must be a string of at most 8 KiB.");
		const source = state.snapshot.files.find((file) => file.role === "learner")!.source;
		const input: CodeRunnerInput = {
			workspaceId: MANIFEST, source, revision: state.revision,
			exercise: { language: "cpp", starterCode: API_DEMO_STARTER, tests: API_DEMO_TESTS },
			supportFiles: state.snapshot.files.filter((file) => file.role !== "learner").map(({ path: filePath, source: content }) => ({ path: filePath, source: content })),
			compileSources: BUILD.sources,
		};
		busy = true;
		try {
			let saved: SavedResult;
			if (command.action === "run") saved = { kind: "run", result: await (options.run ?? runCodeProgram)(input, command.stdin!, { signal }), snapshot: state.snapshot };
			else saved = { kind: "check", result: await (options.check ?? runCodeExercise)(input, { signal }), snapshot: state.snapshot };
			const latest = workspace(); // Reject altered supporting files after asynchronous execution too.
			saveFile(path.join(directory, `${saved.result.id}.json`), JSON.stringify(saved));
			if (saved.kind === "run") latest.metadata.lastRunId = saved.result.id; else latest.metadata.lastCheckId = saved.result.id;
			saveFile(metadataFile, JSON.stringify(latest.metadata));
			return view(latest);
		} finally { busy = false; }
	}
	return { execute };
}

const serviceKey = Symbol.for(`learnharness.api-code-demo.${MANIFEST}`);
const globals = globalThis as typeof globalThis & { [key: symbol]: ReturnType<typeof createApiCodeDemoService> | undefined };
const service = globals[serviceKey] ??= createApiCodeDemoService({ directory: path.join(PATHS.data, "code-api-demo") });

export async function apiCodeDemoResponse(request: Request): Promise<Response> {
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	const error = (message: string, status: number) => Response.json({ error: message }, { status, headers });
	if (!codeWorkspaceRequestAuthorized(request)) return error("The API code demo requires the local LearnHarness window.", 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error("Expected a JSON demo action.", 415);
	try {
		const value = await readBoundedJson(request, 128 * 1024);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodeWorkspaceError("Invalid demo action.");
		const command = value as Record<string, unknown>;
		if (!["load", "save", "run", "check", "open"].includes(String(command.action))) throw new CodeWorkspaceError("Invalid demo action.");
		for (const field of ["source", "expectedRevision", "stdin"]) if (command[field] !== undefined && typeof command[field] !== "string") throw new CodeWorkspaceError(`Invalid ${field}.`);
		if (command.editor !== undefined && !["vscode", "cursor", "default"].includes(String(command.editor))) throw new CodeWorkspaceError("Choose VS Code, Cursor, or Default editor.");
		return Response.json(await service.execute(command as unknown as ApiCodeDemoCommand, request.signal), { headers });
	} catch (err) {
		if (err instanceof CodeWorkspaceError) return error(err.message, err.status);
		if (err instanceof CustomBodyLimitError) return error("Demo request is too large.", 413);
		if (err instanceof SyntaxError) return error("Invalid demo data.", 400);
		if (["ELOOP", "ENOENT", "EEXIST", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return error("A project file was removed or replaced. Restore the supplied files and reload.", 409);
		return error(err instanceof Error ? err.message : "The API code demo could not complete the request.", 400);
	}
}
