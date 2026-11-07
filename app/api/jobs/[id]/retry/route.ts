import { retryDemoResponse } from "@/src/server";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	return retryDemoResponse(req, (await params).id);
}
