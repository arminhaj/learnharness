import { parseMoleculeDocument, type MoleculeDocument } from "./chemistry.ts";
import { collectMoleculeReferences, publicChemistryContext, type MoleculeReference } from "./chemistry-references.ts";
import { parseAskInput, parseExplainInput } from "./tool-parts.ts";
import type { LhViewMessage, LhViewPart } from "./view.ts";

const questionTools = new Set(["tool-quiz", "tool-probe", "tool-ask_user_question", "tool-explain", "tool-recall", "tool-problem"]);
const editableTools = new Set(["tool-ask_user_question", "tool-explain", "tool-recall"]);
const isQuestion = (part: LhViewPart) => questionTools.has(part.type) && part.state !== "output-error" && part.state !== "input-streaming";
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Compatibility for questions posed before the explicit reuse flag existed.
 * Only public edit instructions count; commitments and hints are never read. */
function requestsDirectEdit(input: Record<string, unknown>): boolean {
	const prose = [input.question, input.details].filter((value): value is string => typeof value === "string").join("\n");
	const edit = /(?:^|[\n.!?:;])[\s>*#_-]*(?:please\s+)?(?:repair|edit|revise|fix|correct|update|modify|adjust|complete|finish|add|change|specify)\b/i;
	const previousDrawing = /\b(?:your|existing|original|previous|earlier|saved|submitted)\b[^.!?\n]{0,100}\b(?:mechanism|synthesis|drawing|structure|product|frames?|steps?)\b/i;
	return edit.test(prose) && previousDrawing.test(prose);
}

/** A separate editable copy of the learner's submitted drawing in this chat.
 * The current call is a hard cutoff, including when call IDs are reused. */
function previousStructure(parts: readonly LhViewPart[], end: number): { index: number; molecule: MoleculeDocument } | undefined {
	const subject = parts[end];
	if (!subject || !isQuestion(subject) || !editableTools.has(subject.type)) return undefined;
	const input = object(subject.input);
	if (!input || input.codeExercise || (Array.isArray(input.options) && input.options.length)) return undefined;
	// Persisted calls keep the raw arguments, including values converted at
	// the tool boundary. Use the same display parse as the question dock.
	const parsed = subject.type === "tool-ask_user_question" ? parseAskInput(input) : parseExplainInput(input);
	if (!parsed) return undefined;
	const reuse = parsed.reusePreviousStructure;
	if (reuse === false || (reuse !== true && !requestsDirectEdit(input))) return undefined;
	for (let index = end - 1; index >= 0; index--) {
		const part = parts[index]!;
		if (!isQuestion(part)) continue;
		const priorInput = object(part.input);
		// A declared edit may span plan nodes (for example, mechanism to
		// stereochemistry). Legacy wording alone must stay on the same node.
		if (reuse !== true && input.nodeId && priorInput?.nodeId && input.nodeId !== priorInput.nodeId) return undefined;
		if (part.state !== "output-available") return undefined;
		const answer = object(part.output);
		if (answer?.molecule && !answer.dismissed && !answer.dontKnow) {
			try { return { index, molecule: parseMoleculeDocument(answer.molecule) }; }
			catch { return undefined; }
		}
		// Legacy wording only reuses the immediately preceding answer. An
		// explicit request can reach past intervening conceptual questions.
		if (reuse !== true) return undefined;
	}
	return undefined;
}

export function questionStructureContinuation(messages: readonly LhViewMessage[], subjectToolCallId: string): MoleculeDocument | undefined {
	if (!subjectToolCallId) return undefined;
	const parts = messages.filter(message => message.role === "assistant").flatMap(message => message.parts);
	const end = parts.findLastIndex(part => questionTools.has(part.type) && part.toolCallId === subjectToolCallId);
	return previousStructure(parts, end)?.molecule;
}

export interface QuestionChemistryContinuation {
	molecule: MoleculeDocument;
	/** Newest first; keys use the same chat and occurrence scope as the dock. */
	referenceDraftKeys: string[];
	problemReferences: MoleculeReference[];
}

/** References follow exactly the same chain as editable synthesis copies.
 * Read only visible question fields and prose, never grading commitments. */
export function questionChemistryContinuation(messages: readonly LhViewMessage[], subjectToolCallId: string, chatId: string): QuestionChemistryContinuation | undefined {
	if (!subjectToolCallId || !chatId) return undefined;
	const parts = messages.filter(message => message.role === "assistant").flatMap(message => message.parts);
	const end = parts.findLastIndex(part => questionTools.has(part.type) && part.toolCallId === subjectToolCallId);
	const first = previousStructure(parts, end);
	if (!first) return undefined;
	const referenceDraftKeys: string[] = [];
	const prose: string[] = [];
	const additional: { smiles: string; label: string }[] = [];
	let source: ReturnType<typeof previousStructure> = first;
	while (source) {
		const part = parts[source.index]!;
		const key = part.questionKey ?? (parts.filter(candidate => candidate.toolCallId === part.toolCallId && questionTools.has(candidate.type)).length === 1 ? part.toolCallId : undefined);
		if (key) referenceDraftKeys.push(`question:${chatId}:${key}`);
		const input = object(part.input);
		prose.push(...publicChemistryContext([{ role: "assistant", parts: parts.slice(0, source.index + 1) }], part.toolCallId!));
		for (const field of [input?.question, input?.details, input?.statement]) if (typeof field === "string") prose.push(field);
		if (part.type === "tool-problem") {
			const chemistry = object(input?.chemistry);
			if (typeof chemistry?.instructions === "string") prose.push(chemistry.instructions);
			if (typeof chemistry?.startingStructure === "string") additional.push({ smiles: chemistry.startingStructure, label: "Starting structure" });
		}
		source = previousStructure(parts, source.index);
	}
	return { molecule: first.molecule, referenceDraftKeys, problemReferences: collectMoleculeReferences(prose, additional) };
}
