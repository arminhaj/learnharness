import type { ChatDraftEdit } from "@/src/core";

let previousRevision = 0;

/** Keep the latest edit even when requests reach the local server out of order. */
export function persistChatDraft(chatId: string, edit: ChatDraftEdit): void {
	const revision = Math.max(performance.timeOrigin + performance.now(), previousRevision + 0.01);
	previousRevision = revision;
	const body = JSON.stringify({ ...edit, revision });
	void fetch(`/api/chats/${encodeURIComponent(chatId)}/draft`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body,
		keepalive: new TextEncoder().encode(body).length < 60_000,
	}).catch(() => { /* The mounted session still retains the draft. */ });
}
