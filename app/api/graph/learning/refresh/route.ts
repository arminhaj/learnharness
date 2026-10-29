import { effectiveSettings, extraction, extractionStatuses, providerKeyPresent, stores } from "@/src/server";
import { resolveRoleSpec, ROLE_SLOT } from "@/src/core";

export const dynamic = "force-dynamic";

/** Backfill existing sessions with the same automatic, correctable updater
 * used after turns. Work appears in the existing activity dock. */
export async function POST(request: Request) {
	let body: unknown;
	try { body = await request.json(); }
	catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
	if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Expected an object" }, { status: 400 });
	const { chatId } = body as { chatId?: unknown };
	if (chatId !== undefined && (typeof chatId !== "string" || !chatId)) return Response.json({ error: "chatId must be a non-empty string" }, { status: 400 });
	if (typeof chatId === "string" && !stores.chatStore.getChat(chatId)) return Response.json({ error: "No such session" }, { status: 404 });
	if (!effectiveSettings().graph.enabled) return Response.json({ error: "Enable the knowledge graph before updating the learning map" }, { status: 409 });
	const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings());
	if (!spec) return Response.json({ error: "Configure an extraction model in Settings first", code: "models_not_configured", missing: [ROLE_SLOT.extractor] }, { status: 503 });
	if (!providerKeyPresent(spec.provider)) return Response.json({ error: "The extraction model needs its provider connection or key", code: "provider_key_missing", provider: spec.provider }, { status: 503 });
	const ids = typeof chatId === "string" ? [chatId] : stores.chatStore.listChats().map((chat) => chat.id);
	const active = new Set(extractionStatuses().map((run) => run.chatId));
	if (chatId === undefined && active.size) return Response.json({ error: "Wait for the current map update to finish before refreshing all sessions" }, { status: 409 });
	if (typeof chatId === "string" && active.has(chatId)) return Response.json({ error: "This session is already updating" }, { status: 409 });
	const queued = ids.filter((id) => !active.has(id));
	// Sequential sources keep a large backfill polite to the provider. Each
	// source's worker batches independently and can be aborted from the dock.
	void (async () => {
		for (const id of queued) {
			try { await extraction.updateLearning?.(id, { force: true }); }
			catch (error) { console.error(`[learning ${id}] requested refresh failed:`, error); }
		}
	})();
	return Response.json({ started: true, queued: queued.length, skipped: ids.length - queued.length }, { status: 202 });
}
