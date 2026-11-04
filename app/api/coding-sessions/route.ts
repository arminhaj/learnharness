import { codingGenerationResponse } from "@/src/server/coding-generation";

export const runtime = "nodejs";

export function POST(request: Request) {
	return codingGenerationResponse(request);
}
