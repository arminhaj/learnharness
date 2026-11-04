import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { ChatDraftEdit, SavedChatDraft } from "../core/chat-drafts.ts";

type DraftFile = SavedChatDraft & { revisions: Partial<Record<ChatDraftEdit["field"], number>> };

function draftFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, "drafts", `${id}.json`);
}

function read(id: string): DraftFile {
	try { return JSON.parse(fs.readFileSync(draftFile(id), "utf-8")) as DraftFile; }
	catch { return { revisions: {} }; }
}

export function readChatDraft(id: string): SavedChatDraft | undefined {
	const { composer, question } = read(id);
	return composer === undefined && question === undefined ? undefined : { composer, question };
}

/** Small atomic sidecar writes leave the transcript and its update time alone. */
export function saveChatDraft(id: string, edit: ChatDraftEdit, revision: number): void {
	const current = read(id);
	if ((current.revisions[edit.field] ?? 0) >= revision) return;
	current.revisions[edit.field] = revision;
	if (edit.field === "composer") current.composer = edit.value;
	else if (edit.value) current.question = edit.value;
	else delete current.question;
	const target = draftFile(id);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(`${target}.tmp`, JSON.stringify(current), { mode: 0o600 });
	fs.renameSync(`${target}.tmp`, target);
}

export function deleteChatDraft(id: string): void {
	fs.rmSync(draftFile(id), { force: true });
}
