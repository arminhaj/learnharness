"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { BookmarkPlusIcon, CheckIcon } from "lucide-react";
import { momentKinds, momentLabels, type LearningMoment } from "@/src/core";
import { useServerEvent, useServerResync } from "./server-events";

const MomentContext = createContext<{ chatId: string; moments: LearningMoment[]; messageIds: Set<string>; refresh(): void } | null>(null);

/** One subscription/read per teaching session, not one per passage. Child
 * explorations get their own provider so anchors cannot cross sessions. */
export function LearningMomentsProvider({ chatId, busy = false, children }: { chatId: string; busy?: boolean; children: ReactNode }) {
	const [moments, setMoments] = useState<LearningMoment[]>([]);
	const [messageIds, setMessageIds] = useState(new Set<string>());
	const refresh = useCallback(() => { void fetch(`/api/learning-history?chatId=${encodeURIComponent(chatId)}`).then(async response => { if (response.ok) { const data = await response.json(); setMoments(data.moments); setMessageIds(new Set(data.messageIds)); } }).catch(() => {}); }, [chatId]);
	useEffect(refresh, [refresh, busy]);
	useServerEvent("learning-history-changed", refresh);
	useServerResync(refresh);
	return <MomentContext.Provider value={{ chatId, moments, messageIds, refresh }}>{children}</MomentContext.Provider>;
}

export function MarkLearningMoment({ messageId }: { messageId: string }) {
	const context = useContext(MomentContext);
	const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null), [note, setNote] = useState("");
	if (!context || !context.messageIds.has(messageId)) return null;
	const marker = context.moments.find(m => m.messageId === messageId);
	async function save(kind: LearningMoment["kind"] | null) {
		setSaving(true); setError(null);
		try {
			const response = await fetch("/api/learning-history", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "mark", chatId: context!.chatId, messageId, kind, note, surface: "session" }) });
			const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Could not save this moment.");
			context!.refresh(); setOpen(false);
		} catch (error) { setError(error instanceof Error ? error.message : "Could not save this moment."); }
		finally { setSaving(false); }
	}
	return <div className="lh-no-drag my-2 font-ui text-xs" data-testid="learning-moment">
		<button type="button" disabled={saving} aria-expanded={open} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => { setNote(marker?.note ?? ""); setOpen(!open); }}>
			{marker ? <CheckIcon className="size-3" /> : <BookmarkPlusIcon className="size-3" />}{marker ? momentLabels[marker.kind] : "Mark this moment"}
		</button>
		{open && <div className="mt-2 max-w-lg rounded-lg border bg-card p-3">
			<p className="mb-2 font-prose text-sm text-muted-foreground">Pinpoint what changed your understanding. This records your signal, separately from inferred turning points.</p>
			<label className="block">What helped? <span className="text-muted-foreground">(optional)</span><textarea maxLength={4000} className="mt-2 w-full rounded-md border bg-background p-2 font-prose text-lg" value={note} onChange={e => setNote(e.target.value)} rows={2} /></label>
			<div className="mt-2 flex flex-wrap gap-2">{momentKinds.map(kind => <button type="button" disabled={saving} key={kind} className="rounded-md border px-2 py-1 hover:bg-accent" onClick={() => void save(kind)}>{momentLabels[kind]}</button>)}{marker && <button type="button" disabled={saving} className="rounded-md px-2 py-1 hover:bg-accent" onClick={() => void save(null)}>Remove marker</button>}</div>
			{marker && <p className="mt-2 text-muted-foreground">Marked by you {new Date(marker.createdAt).toLocaleString()}</p>}
		</div>}
		{error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
	</div>;
}
