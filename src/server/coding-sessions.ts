import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { CODING_CONTEXT_BYTE_LIMIT, CODING_CONTEXT_FILE_LIMIT, CODING_GOAL_LIMIT, CODING_LANGUAGES, type CodingGoal, type CodingProjectFile, type CodingSession, type CodingSessionSummary, type TeachingCodingStep } from "../core/coding-session.ts";
import { CODE_SOURCE_LIMIT, parseCodeExercise } from "../core/code-workspace.ts";
import { codeFilename } from "./code-runner.ts";
import { chatStore } from "../store/chats.ts";

const sessionDirectory = path.join(PATHS.data, "coding-sessions");
const sessionSizeLimit = 1024 * 1024;
const validId = /^(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|step-[0-9a-f]{64})$/;
const stepPart = /^[a-zA-Z0-9_-]{1,200}$/;

export function parseTeachingCodingStep(value: unknown): TeachingCodingStep {
	const step = object(value);
	if (typeof step.chatId !== "string" || !stepPart.test(step.chatId) || typeof step.nodeId !== "string" || !stepPart.test(step.nodeId)) {
		throw new Error("Choose a step from a Teaching plan.");
	}
	return { chatId: step.chatId, nodeId: step.nodeId };
}

export function getTeachingCodingStep(step: TeachingCodingStep) {
	if (!stepPart.test(step.chatId) || !stepPart.test(step.nodeId)) return null;
	const chat = chatStore.getChat(step.chatId);
	if (!chat || chat.kind === "practice" || !chat.tree) return null;
	const node = chat.tree.nodes.find(node => node.id === step.nodeId);
	return node ? { node, lesson: chat.title } : null;
}

export function teachingCodingSessionId(step: TeachingCodingStep): string {
	return "step-" + createHash("sha256").update(JSON.stringify([step.chatId, step.nodeId])).digest("hex");
}

export function codingLanguages() {
	return CODING_LANGUAGES.filter(({ id }) => codeFilename(id) !== "solution.txt");
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
	return value as Record<string, unknown>;
}

function text(value: unknown, max: number, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} is required and must be at most ${max} characters.`);
	return value.trim();
}

export function parseCodingGoal(value: unknown): CodingGoal {
	const input = object(value);
	if (input.mode !== "problem" && input.mode !== "project") throw new Error("Choose Problem or Project.");
	const language = codingLanguages().find(({ id }) => id === input.language);
	if (!language) throw new Error("Choose a language with a local runner.");
	const goal: CodingGoal = { mode: input.mode, language: language.id, goal: text(input.goal, CODING_GOAL_LIMIT, "Learning goal") };
	if (input.contextFiles === undefined) return goal;
	if (goal.mode !== "project" || !Array.isArray(input.contextFiles) || input.contextFiles.length > CODING_CONTEXT_FILE_LIMIT) {
		throw new Error("Project workspaces accept up to six context files.");
	}
	let bytes = 0;
	goal.contextFiles = input.contextFiles.map(value => {
		const file = object(value);
		const name = text(file.name, 160, "Context file name");
		if (!/^[^./\\][^/\\]*$/.test(name) || typeof file.content !== "string" || !file.content.trim() || file.content.includes("\0")) {
			throw new Error("Choose visible, nonempty text files from the codebase.");
		}
		bytes += Buffer.byteLength(file.content, "utf8");
		if (bytes > CODING_CONTEXT_BYTE_LIMIT) throw new Error("Selected context files must total at most 48 KiB.");
		return { name, content: file.content };
	});
	return goal;
}

export function parseCodingDraft(value: unknown, goal: Pick<CodingGoal, "mode" | "language">): Omit<CodingSession, "id" | "createdAt"> {
	const input = object(value);
	const rawExercise = object(input.exercise);
	if (rawExercise.cargo !== undefined && (goal.mode !== "project" || goal.language !== "rust")) {
		throw new Error("Cargo dependencies are supported only for Rust projects.");
	}
	const exercise = parseCodeExercise({ ...rawExercise, language: goal.language });
	if (goal.mode === "project" && typeof input.simulation !== "boolean") throw new Error("Identify whether the project simulates an API or service.");
	const supportFiles: CodingProjectFile[] = [];
	let projectSize = Buffer.byteLength(exercise.starterCode, "utf8");
	if (!Array.isArray(input.supportFiles) || input.supportFiles.length > 8 || (goal.mode === "problem" && input.supportFiles.length > 0)) {
		throw new Error("A project may include up to eight supporting files. A problem uses one file.");
	}
	const names = new Set([codeFilename(goal.language)]);
	const extension = goal.language === "rust" ? /\.rs$/ : /\.(?:cpp|h|hpp)$/;
	for (const value of input.supportFiles) {
		const file = object(value);
		const name = text(file.path, 80, "File name");
		if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name) || !extension.test(name) || names.has(name.toLowerCase())) {
			throw new Error("Use unique, flat source file names with extensions supported by the selected language.");
		}
		names.add(name.toLowerCase());
		const source = text(file.source, CODE_SOURCE_LIMIT, "Supporting source");
		const size = Buffer.byteLength(source, "utf8");
		if (size > CODE_SOURCE_LIMIT) throw new Error("A supporting file exceeds 64 KiB.");
		projectSize += size;
		if (projectSize > 256 * 1024) throw new Error("The coding project is too large.");
		supportFiles.push({ path: name, source });
	}
	return {
		mode: goal.mode,
		...(goal.mode === "project" ? { simulation: input.simulation as boolean } : {}),
		title: text(input.title, 120, "Title"),
		brief: text(input.brief, 8000, "Exercise brief"),
		hint: text(input.hint, 2000, "Hint"),
		reference: text(input.reference, 8000, "Reference"),
		exercise,
		supportFiles,
	};
}

export function saveCodingSession(draft: Omit<CodingSession, "id" | "createdAt" | "teachingStep">, teachingStep?: TeachingCodingStep): CodingSession {
	const id = teachingStep ? teachingCodingSessionId(teachingStep) : randomUUID();
	const session = { ...draft, id, createdAt: new Date().toISOString(), ...(teachingStep ? { teachingStep } : {}) };
	fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
	const target = path.join(sessionDirectory, `${session.id}.json`);
	const temporary = `${target}.${randomUUID()}.tmp`;
	const serialized = JSON.stringify(session);
	if (Buffer.byteLength(serialized, "utf8") > sessionSizeLimit) throw new Error("The workspace exceeds its storage limit.");
	try {
		fs.writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
		// A concurrent request can publish the same Teaching step first.
		fs.linkSync(temporary, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST" && teachingStep) {
			const existing = getCodingSession(id);
			if (existing) return existing;
		}
		throw error;
	} finally {
		fs.rmSync(temporary, { force: true });
	}
	return session;
}

export function getCodingSession(id: string): CodingSession | null {
	if (!validId.test(id)) return null;
	const file = path.join(sessionDirectory, `${id}.json`);
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.size > sessionSizeLimit) return null;
		const session = object(JSON.parse(fs.readFileSync(file, "utf8")));
		if (session.id !== id || typeof session.createdAt !== "string") return null;
		const exercise = object(session.exercise);
		const goal = parseCodingGoal({ mode: session.mode, language: exercise.language, goal: "saved session" });
		const teachingStep = session.teachingStep === undefined ? undefined : parseTeachingCodingStep(session.teachingStep);
		if (id.startsWith("step-") && (!teachingStep || teachingCodingSessionId(teachingStep) !== id)) return null;
		return { ...parseCodingDraft(session, goal), id, createdAt: session.createdAt, ...(teachingStep ? { teachingStep } : {}) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return null;
	}
}

export function recentCodingSessions(): CodingSessionSummary[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(sessionDirectory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries.filter(file => file.isFile() && file.name.endsWith(".json"))
		.map(file => getCodingSession(file.name.slice(0, -5)))
		.filter((session): session is CodingSession => session !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.slice(0, 20)
		.map(({ id, title, mode, exercise }) => ({ id, title, mode, language: exercise.language }));
}
