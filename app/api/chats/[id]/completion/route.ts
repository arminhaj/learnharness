import { stores } from "@/src/server";

/** Lesson organization does not certify unfinished or unverified plan steps. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body: unknown = await req.json().catch(() => null);
	if (!body || typeof body !== "object" || Array.isArray(body) ||
		!("completed" in body) || typeof body.completed !== "boolean") {
		return Response.json({ error: "completed must be a boolean" }, { status: 400 });
	}
	if (!stores.chatStore.getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const chat = stores.chatStore.setLessonCompleted(id, body.completed);
	return Response.json({ lessonCompleted: chat.lessonCompleted });
}
