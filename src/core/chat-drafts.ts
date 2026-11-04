import type { QuestionDraft, QuestionFormDraft } from "./question-core.ts";

type StoredQuestionDraft = Omit<QuestionDraft, "form"> & {
	form?: Omit<QuestionFormDraft, "selection"> & {
		selection: Omit<QuestionFormDraft["selection"], "selected"> & { selected: number[] };
	};
};

export interface SavedChatDraft {
	composer?: string;
	question?: { key: string; draft: StoredQuestionDraft };
}

export function restoreQuestionDraft(draft: StoredQuestionDraft): QuestionDraft {
	const { form, ...rest } = draft;
	return form ? { ...rest, form: { ...form, selection: { ...form.selection, selected: new Set(form.selection.selected) } } } : rest;
}

export function serializeQuestionDraft(draft: QuestionDraft): StoredQuestionDraft {
	const { form, ...rest } = draft;
	return form ? { ...rest, form: { ...form, selection: { ...form.selection, selected: [...form.selection.selected] } } } : rest;
}

export type ChatDraftEdit =
	| { field: "composer"; value: string }
	| { field: "question"; value: SavedChatDraft["question"] | null };

export function isStoredQuestionDraft(value: unknown): value is StoredQuestionDraft {
	if (!value || typeof value !== "object") return false;
	const { readingThinking, form } = value as Partial<StoredQuestionDraft>;
	return (readingThinking === undefined || typeof readingThinking === "string")
		&& (form === undefined || !!form && typeof form.text === "string" && typeof form.thinking === "string"
			&& typeof form.other === "string" && Number.isInteger(form.confidenceIndex) && !!form.selection
			&& Array.isArray(form.selection.selected) && form.selection.selected.every(Number.isInteger)
			&& typeof form.selection.otherSelected === "boolean" && typeof form.selection.dontKnow === "boolean");
}
