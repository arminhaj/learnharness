import { isStoredQuestionDraft, type ChatDraftEdit } from "@/src/core";
import { getChat, saveChatDraft } from "@/src/server";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "No such session" }, { status: 404 });
	const raw = await request.text();
	if (raw.length > 1_000_000) return Response.json({ error: "Draft is too large" }, { status: 413 });
	const body = (() => {
		try { return JSON.parse(raw) as ChatDraftEdit & { revision: number }; }
		catch { return null; }
	})();
	if (!body || !Number.isFinite(body.revision) || body.revision <= 0
		|| !(body.field === "composer" && typeof body.value === "string"
			|| body.field === "question" && (body.value === null
				|| typeof body.value?.key === "string" && isStoredQuestionDraft(body.value.draft)))) {
		return Response.json({ error: "Invalid draft" }, { status: 400 });
	}
	// Recheck after reading the request body so deletion cannot leave a draft orphan.
	if (!getChat(id)) return Response.json({ error: "No such session" }, { status: 404 });
	saveChatDraft(id, body, body.revision);
	return new Response(null, { status: 204 });
}
