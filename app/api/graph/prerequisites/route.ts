import { updateLearningPrerequisite } from "@/src/server";

export async function PATCH(request: Request) {
	let body: unknown;
	try { body = await request.json(); }
	catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
	const outcome = updateLearningPrerequisite(body);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ learning: outcome.learning, graphRevision: outcome.graphRevision });
}
