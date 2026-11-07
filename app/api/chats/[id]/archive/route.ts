import { stores } from "@/src/server";

/** Manual organization only: archived sessions retain their content and graph
 * history, and remain readable through the ordinary session endpoints. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body: unknown = await req.json().catch(() => null);
	if (!body || typeof body !== "object" || Array.isArray(body) ||
		!("archived" in body) || typeof body.archived !== "boolean") {
		return Response.json({ error: "archived must be a boolean" }, { status: 400 });
	}
	if (!stores.chatStore.getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const chat = stores.chatStore.setArchived(id, body.archived);
	return Response.json({ archivedAt: chat.archivedAt ?? null });
}
