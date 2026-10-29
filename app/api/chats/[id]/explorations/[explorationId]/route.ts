import { updateExploration, requestExplorationExtraction } from "@/src/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; explorationId: string }> }) {
	const { id, explorationId } = await params;
	const body = await request.json().catch(() => null);
	const outcome = updateExploration(id, explorationId, body?.action);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	if (body.action === "close") requestExplorationExtraction(explorationId);
	return Response.json({ chat: outcome.chat });
}
