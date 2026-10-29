import { createExploration, getChat, listExplorations } from "@/src/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "No such lesson" }, { status: 404 });
	return Response.json({ explorations: listExplorations(id) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await request.json().catch(() => null);
	const outcome = createExploration(id, body);
	return outcome.ok
		? Response.json({ chat: outcome.chat }, { status: 201 })
		: Response.json({ error: outcome.error }, { status: outcome.status });
}
