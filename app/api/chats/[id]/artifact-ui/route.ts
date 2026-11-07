/**
 * THE ARTIFACT-UI ROUTE (owner, 2026-10-07): persists the learner's invert
 * switch onto a demo/figure steer message (details.ui.inverted) so it
 * survives session navigation and restarts. Modeled on the dismissal
 * route's SILENCE: no wake, no agent, no tokens. Artifacts shown before
 * teacher-facing delivery save their preference on the completed job;
 * the client already holds the toggled state optimistically.
 *
 * Guards: 404 unknown chat, 400 for a body that isn't
 * { input: { messageId, inverted } } or targets no demo/visual steer.
 */
import { setSteerUiInverted, type DemoResult, type SteerDetails, type VisualResult } from "@/src/core";
import { getChat, stores } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });

	const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
	const input = body?.input as { messageId?: unknown; inverted?: unknown } | null | undefined;
	if (
		!input ||
		typeof input !== "object" ||
		typeof input.messageId !== "string" ||
		typeof input.inverted !== "boolean"
	) {
		return Response.json({ error: "input must be { messageId: string, inverted: boolean }" }, { status: 400 });
	}

	// Honesty: the target must actually be a demo/figure steer.
	const target = chat.messages.find((m) => m.id === input.messageId);
	if (!target && input.messageId.startsWith("steer_")) {
		const job = stores.jobStore.getJob(input.messageId.slice("steer_".length));
		if (job?.chatId === id && job.status === "done" && job.delivery?.kind === "result") {
			const figure = job.result as VisualResult | undefined;
			const demo = job.result as DemoResult | undefined;
			const validFigure = job.kind === "visual" && typeof figure?.svg === "string" && figure.svg.length > 0;
			const validDemo = job.kind === "demo" && demo?.tested === true &&
				typeof demo.html === "string" && demo.html.trim().length > 0 &&
				typeof demo.title === "string" && demo.title.trim().length > 0;
			if (validFigure || validDemo) {
				stores.jobStore.updateJob(job.id, { ui: { ...job.ui, inverted: input.inverted } });
				return Response.json({ ok: true });
			}
		}
	}
	const details = target ? ((target as { details?: unknown }).details as Partial<SteerDetails> | undefined) : undefined;
	if (!details || (details.kind !== "demo" && details.kind !== "visual")) {
		return Response.json({ error: "No demo/figure steer with that message id" }, { status: 400 });
	}

	const messages = setSteerUiInverted(chat.messages, input.messageId, input.inverted);
	stores.chatStore.saveMessages(id, messages);
	return Response.json({ ok: true });
}
