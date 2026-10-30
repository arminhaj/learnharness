import { HistoryRequestError, learningHistory } from "@/src/server";

export const dynamic = "force-dynamic";
function errorResponse(error: unknown) {
	return Response.json({ error: error instanceof Error ? error.message : "Learning history is unavailable." }, { status: error instanceof HistoryRequestError ? error.status : 500 });
}
export async function GET(request: Request) { try { const chatId = new URL(request.url).searchParams.get("chatId"); return Response.json(chatId ? { moments: learningHistory.momentsFor(chatId), messageIds: learningHistory.momentTargets(chatId) } : learningHistory.snapshot()); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) {
	try {
		const body = await request.json();
		if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["chatId", "cancel", "retryFailed"].includes(key)) || (body.chatId !== undefined && (typeof body.chatId !== "string" || !body.chatId)) || (body.cancel !== undefined && typeof body.cancel !== "boolean") || (body.retryFailed !== undefined && typeof body.retryFailed !== "boolean") || (body.retryFailed && (body.cancel || body.chatId))) throw new HistoryRequestError("Invalid history request.");
		if (body.cancel) { learningHistory.cancel(); return Response.json({ stopped: true }); }
		return Response.json(learningHistory.refresh(body.chatId, body.retryFailed === true), { status: 202 });
	} catch (error) { return errorResponse(error instanceof SyntaxError ? new HistoryRequestError("Invalid JSON body.") : error); }
}
export async function PATCH(request: Request) {
	try { return Response.json(learningHistory.mutate(await request.json())); }
	catch (error) { return errorResponse(error instanceof SyntaxError ? new HistoryRequestError("Invalid JSON body.") : error); }
}
