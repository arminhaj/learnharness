import { codingGenerationResponse } from "@/src/server";

export const runtime = "nodejs";

export function POST(request: Request) {
	return codingGenerationResponse(request);
}
