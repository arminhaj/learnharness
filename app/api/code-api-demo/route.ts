import { apiCodeDemoResponse } from "@/src/server";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
	return apiCodeDemoResponse(request);
}
