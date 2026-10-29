/** A one-time handoff for the home composer when a concept starts a session. */
export interface HomeDraft {
	topic: string;
	mode: "teach" | "practice";
	picks: readonly { id: string; name: string; statement: string }[];
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const HOME_DRAFT_KEY = "lh.homeDraft.conceptLaunch";
const HOME_DRAFT_FAILURE = "Couldn’t preserve your home draft. Copy it before leaving, then try again when browser storage is available.";

function parseDraft(value: unknown): HomeDraft | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const draft = value as Partial<HomeDraft>;
	if (typeof draft.topic !== "string" || (draft.mode !== "teach" && draft.mode !== "practice") || !Array.isArray(draft.picks)) return null;
	if (!draft.picks.every((pick: unknown) => {
		if (!pick || typeof pick !== "object" || Array.isArray(pick)) return false;
		const candidate = pick as Partial<HomeDraft["picks"][number]>;
		return typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.statement === "string";
	})) return null;
	return { topic: draft.topic, mode: draft.mode, picks: draft.picks.map(({ id, name, statement }) => ({ id, name, statement })) };
}

/** Verify the write before the caller navigates away from its draft. */
export function stashHomeDraft(draft: HomeDraft, storage?: DraftStorage | null): boolean {
	try {
		const target = storage === undefined ? globalThis.sessionStorage : storage;
		if (!target) return false;
		const value = JSON.stringify(draft);
		target.setItem(HOME_DRAFT_KEY, value);
		return target.getItem(HOME_DRAFT_KEY) === value;
	} catch { return false; }
}

/** Preserve edits made while session creation or dictation is still pending. */
export async function withHomeDraftHandoff<T>(readDraft: () => HomeDraft, prepareDestination: () => Promise<T>, storage?: DraftStorage | null): Promise<T> {
	try {
		if (!stashHomeDraft(readDraft(), storage)) throw new Error(HOME_DRAFT_FAILURE);
		const destination = await prepareDestination();
		if (!stashHomeDraft(readDraft(), storage)) throw new Error(HOME_DRAFT_FAILURE);
		return destination;
	} catch (error) {
		clearHomeDraft(storage);
		throw error;
	}
}

/** Consume both valid and corrupt handoffs; never replay a draft twice. */
export function takeHomeDraft(storage?: DraftStorage | null): HomeDraft | null {
	try {
		const target = storage === undefined ? globalThis.sessionStorage : storage;
		if (!target) return null;
		const value = target.getItem(HOME_DRAFT_KEY);
		if (value === null) return null;
		target.removeItem(HOME_DRAFT_KEY);
		if (target.getItem(HOME_DRAFT_KEY) !== null) return null;
		return parseDraft(JSON.parse(value));
	} catch { return null; }
}

/** Failed concept launches leave the still-mounted composer as the truth. */
export function clearHomeDraft(storage?: DraftStorage | null): void {
	try {
		const target = storage === undefined ? globalThis.sessionStorage : storage;
		target?.removeItem(HOME_DRAFT_KEY);
	} catch { /* Storage can be unavailable without affecting the live draft. */ }
}
