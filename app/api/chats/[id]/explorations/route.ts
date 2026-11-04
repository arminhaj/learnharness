import { createExploration, explorationPath, getChat, listExplorations, readChatDraft } from "@/src/server";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "No such lesson" }, { status: 404 });
	const target = new URL(request.url).searchParams.get("target");
	const path = target ? explorationPath(target) : [];
	const index = path.indexOf(id);
	const requestedChildId = index < 0 ? undefined : path[index + 1];
	const explorations = listExplorations(id).map(chat => ({ ...chat, draft: readChatDraft(chat.id) }));
	return Response.json({ explorations, requestedChildId });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await request.json().catch(() => null);
	const outcome = createExploration(id, body);
	return outcome.ok
		? Response.json({ chat: outcome.chat }, { status: 201 })
		: Response.json({ error: outcome.error }, { status: outcome.status });
}
