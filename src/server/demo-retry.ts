import { latestJobAttempt, type DemoToolInput, type JobRecord } from "../core/contracts/jobs.ts";
import type { ChatStore, JobStore } from "../core/ports.ts";

export interface DemoRetryDeps {
	chatStore: Pick<ChatStore, "getChat">;
	jobStore: JobStore;
	isTurnRunning(chatId: string): boolean;
	canSupersedeJobDelivery(jobId: string): boolean;
	supersedeJobDelivery(jobId: string): void;
	spawn(jobId: string): void;
}

type RetryOutcome = { status: 200 | 202; job: JobRecord } | { status: 404 | 409; error: string };

function demoInput(value: unknown): DemoToolInput | null {
	if (!value || typeof value !== "object") return null;
	const { title, brief } = value as Partial<DemoToolInput>;
	return typeof title === "string" && title.trim() && typeof brief === "string" && brief.trim()
		? { title, brief } : null;
}

/** Admission is synchronous: concurrent/stale clicks share the saved child
 * before any worker starts. A retry changes jobs only, never the lesson's
 * question, transcript, or teacher turn. The existing runner resolves the
 * current builder settings and performs its usual verification. */
export function retryDemoJob(deps: DemoRetryDeps, jobId: string, chatId: string): RetryOutcome {
	const source = deps.jobStore.getJob(jobId);
	const chat = deps.chatStore.getChat(chatId);
	if (!source || source.chatId !== chatId || !chat) return { status: 404, error: "Demo job not found." };
	if (source.kind !== "demo" || source.status !== "error") {
		return { status: 409, error: "Only failed demos can be retried." };
	}
	const latest = latestJobAttempt(deps.jobStore.listJobs(chatId), source.toolCallId);
	if (latest && latest.id !== source.id) return { status: 200, job: latest };
	if (deps.isTurnRunning(chatId) || !deps.canSupersedeJobDelivery(jobId)) {
		return { status: 409, error: "The lesson is still responding. Retry when it finishes." };
	}
	let input = demoInput(source.input);
	if (source.input === undefined) {
		for (const message of chat.messages) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const part of message.content) {
				if (part.type === "toolCall" && part.name === "demo" && part.id === source.toolCallId) {
					input = demoInput(part.arguments);
				}
			}
		}
	}
	if (!input) return { status: 409, error: "The original demo brief is no longer available. Ask the teacher to create a new demo." };
	const job = deps.jobStore.createJob({
		kind: "demo", chatId, toolCallId: source.toolCallId, input, retryOf: source.id,
	});
	// The saved retry link makes the old notice obsolete even if the process
	// exits between these writes. No await can let delivery race admission.
	deps.supersedeJobDelivery(source.id);
	deps.spawn(job.id);
	return { status: 202, job };
}

export async function demoRetryResponse(req: Request, jobId: string, deps: DemoRetryDeps): Promise<Response> {
	if (!/^[A-Za-z0-9_-]+$/.test(jobId)) return Response.json({ error: "Invalid job id." }, { status: 400 });
	let body: unknown;
	try { body = await req.json(); } catch {
		return Response.json({ error: "Invalid JSON body." }, { status: 400 });
	}
	const chatId = (body as { chatId?: unknown } | null)?.chatId;
	if (typeof chatId !== "string" || !/^[A-Za-z0-9_-]+$/.test(chatId)) {
		return Response.json({ error: "A valid chatId is required." }, { status: 400 });
	}
	const { status, ...payload } = retryDemoJob(deps, jobId, chatId);
	return Response.json(payload, { status });
}
