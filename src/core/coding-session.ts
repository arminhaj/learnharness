import type { CodeExercise } from "./code-workspace.ts";

export const CODING_LANGUAGES = [
	{ id: "cpp", label: "C++20" },
	{ id: "rust", label: "Rust 2021" },
] as const;

export type CodingLanguageId = (typeof CODING_LANGUAGES)[number]["id"];
export type CodingMode = "problem" | "project";

export interface TeachingCodingStep {
	chatId: string;
	nodeId: string;
}

export interface CodingGoal {
	mode: CodingMode;
	language: CodingLanguageId;
	goal: string;
	contextFiles?: { name: string; content: string }[];
}

export interface CodingProjectFile {
	path: string;
	source: string;
}

export interface CodingSession {
	id: string;
	title: string;
	createdAt: string;
	teachingStep?: TeachingCodingStep;
	mode: CodingMode;
	simulation?: boolean;
	brief: string;
	hint: string;
	reference: string;
	exercise: CodeExercise;
	supportFiles: CodingProjectFile[];
}

export interface CodingSessionSummary {
	id: string;
	title: string;
	mode: CodingMode;
	language: string;
}

export const CODING_GOAL_LIMIT = 4000;
export const CODING_CONTEXT_FILE_LIMIT = 6;
export const CODING_CONTEXT_BYTE_LIMIT = 48 * 1024;
