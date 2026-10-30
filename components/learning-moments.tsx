"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BookmarkPlusIcon, CheckIcon, XIcon } from "lucide-react";
import { momentKinds, momentLabels, momentTextFingerprint, type LearningMoment, type MomentSelection } from "@/src/core";
import { useServerEvent, useServerResync } from "./server-events";
import { momentAtPoint, momentDisplay, momentRoots, readMomentSelection, resolveMomentSelection } from "./learning-moment-dom";
import { LEARNING_MOMENT_JUMP } from "./session-navigation";

interface Popup {
	messageId: string; selection?: MomentSelection; excerpt: string; range?: Range;
	marker?: LearningMoment; editing: boolean; x: number; y: number;
}
const MomentContext = createContext<{ moments: LearningMoment[]; edit(marker: LearningMoment): void } | null>(null);
const position = (x: number, y: number) => ({ x: Math.max(12, Math.min(x, window.innerWidth - 360)), y: Math.max(12, Math.min(y + 8, window.innerHeight - 390)) });
const actionClass = "rounded-md border px-3 py-2 text-xs hover:bg-accent disabled:opacity-40";

function jumpToPassage(range: Range) {
	const event = new CustomEvent(LEARNING_MOMENT_JUMP, { detail: { range }, cancelable: true });
	window.dispatchEvent(event);
	if (!event.defaultPrevented) range.startContainer.parentElement?.scrollIntoView?.({ block: "center" });
}

/** One selection controller per session; nested explorations own their own
 * scope. Only persisted, eligible conversation messages can receive markers. */
export function LearningMomentsProvider({ chatId, busy = false, children }: { chatId: string; busy?: boolean; children: ReactNode }) {
	const scopeRef = useRef<HTMLDivElement>(null);
	const [moments, setMoments] = useState<LearningMoment[]>([]);
	const [messageIds, setMessageIds] = useState(new Set<string>());
	const [popup, setPopup] = useState<Popup | null>(null);
	const popupRef = useRef(popup); popupRef.current = popup;
	const [note, setNote] = useState(""), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
	const readVersion = useRef(0);
	const refresh = useCallback(() => {
		const version = ++readVersion.current;
		void fetch(`/api/learning-history?chatId=${encodeURIComponent(chatId)}`).then(async response => {
			if (response.ok) { const data = await response.json(); if (version === readVersion.current) { setMoments(data.moments ?? []); setMessageIds(new Set(data.messageIds ?? [])); } }
		}).catch(() => {});
	}, [chatId]);
	useEffect(refresh, [refresh, busy]);
	useEffect(() => () => { readVersion.current++; }, [chatId]);
	useServerEvent("learning-history-changed", refresh);
	useServerResync(refresh);

	const resolve = useCallback((marker: LearningMoment) => {
		if (!scopeRef.current) return null;
		for (const root of momentRoots(scopeRef.current, marker.messageId)) {
			if (!marker.selection) return { root, range: undefined, excerpt: "" };
			const resolved = resolveMomentSelection(root, marker.selection);
			if (resolved) return { root, ...resolved };
		}
		return null;
	}, []);
	const edit = useCallback((marker: LearningMoment) => {
		const found = resolve(marker);
		if (found?.range) jumpToPassage(found.range);
		const rect = found?.range?.getBoundingClientRect() ?? found?.root.getBoundingClientRect();
		setNote(marker.note); setError(null);
		setPopup({ messageId: marker.messageId, selection: marker.selection, marker, excerpt: found?.excerpt ?? "", range: found?.range, editing: true, ...position(rect?.left ?? 24, rect?.bottom ?? 80) });
	}, [resolve]);

	useEffect(() => {
		const onSelection = () => {
			if (popupRef.current?.editing) return;
			const selected = readMomentSelection(document, chatId);
			if (!selected || !messageIds.has(selected.messageId)) { setPopup(null); return; }
			const rect = selected.range.getBoundingClientRect();
			const marker = moments.find(m => m.messageId === selected.messageId && JSON.stringify(m.selection) === JSON.stringify(selected.selection));
			setPopup({ ...selected, marker, editing: false, ...position(rect.left, rect.bottom) });
		};
		const onPointerDown = (event: PointerEvent) => {
			if (!(event.target as Element)?.closest?.('[data-learning-moment-ui]')) { setPopup(null); popupRef.current = null; }
		};
		const onPointerUp = (event: PointerEvent) => {
			if ((event.target as Element)?.closest?.('[data-learning-moment-ui]')) return;
			if (!document.getSelection()?.isCollapsed) { onSelection(); return; }
			const root = (event.target as Element)?.closest?.<HTMLElement>('[data-source-message-id]');
			if (!root || root.closest('[data-learning-chat-id]') !== scopeRef.current) return;
			const offset = momentAtPoint(root, event.clientX, event.clientY);
			if (offset === null) return;
			const found = moments.filter(m => m.messageId === root.dataset.sourceMessageId && m.selection && m.selection.start <= offset && offset < m.selection.end && resolveMomentSelection(root, m.selection))
				.sort((a, b) => (a.selection!.end - a.selection!.start) - (b.selection!.end - b.selection!.start))[0];
			if (found) edit(found);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !popupRef.current) return;
			event.preventDefault(); event.stopPropagation(); setPopup(null); popupRef.current = null;
		};
		const onScroll = (event: Event) => {
			if ((event.target as Element)?.closest?.('[data-learning-moment-ui]')) return;
			if (!popupRef.current?.editing) setPopup(null);
		};
		document.addEventListener("selectionchange", onSelection);
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("pointerup", onPointerUp);
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("selectionchange", onSelection);
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("pointerup", onPointerUp);
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("scroll", onScroll, true);
		};
	}, [chatId, messageIds, moments, edit]);

	// Custom Highlights preserve React's message DOM and the learner's drafts.
	// One named set per provider prevents a child exploration clearing its parent.
	const highlightName = `lh-moments-${momentTextFingerprint(chatId)}`;
	useEffect(() => {
		if (!scopeRef.current || typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
		const scope = scopeRef.current;
		const paint = () => {
			const highlights = new Highlight();
			for (const marker of moments) { const found = marker.selection && resolve(marker); if (found?.range) highlights.add(found.range); }
			if (popup?.range?.startContainer.isConnected) highlights.add(popup.range);
			CSS.highlights.set(highlightName, highlights);
		};
		paint();
		const observer = new window.MutationObserver(paint);
		observer.observe(scope, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["open", "hidden"] });
		return () => { observer.disconnect(); CSS.highlights.delete(highlightName); };
	}, [highlightName, moments, popup, resolve]);

	// History links retain the ordinary source-message hash and add the marker
	// identity. Wait for a lazy-loaded inline exploration before opening it.
	const openedMoment = useRef<string | null>(null);
	useEffect(() => {
		const openLinked = () => {
			const id = new URLSearchParams(window.location.search).get("moment");
			if (!id || openedMoment.current === id) return;
			const marker = moments.find(m => m.id === id);
			if (!marker || !scopeRef.current || !momentRoots(scopeRef.current, marker.messageId).length) return;
			openedMoment.current = id; edit(marker);
		};
		openLinked();
		const observer = new window.MutationObserver(openLinked);
		if (scopeRef.current) observer.observe(scopeRef.current, { subtree: true, childList: true });
		window.addEventListener("popstate", openLinked);
		return () => { observer.disconnect(); window.removeEventListener("popstate", openLinked); };
	}, [moments, edit]);

	async function save(kind: LearningMoment["kind"] | null) {
		if (!popup) return;
		setSaving(true); setError(null);
		try {
			const response = await fetch("/api/learning-history", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "mark", chatId, messageId: popup.messageId, momentId: popup.marker?.id, selection: popup.selection, kind, note, surface: "session" }) });
			const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Could not save this moment.");
			readVersion.current++;
			setMoments(body.moments.filter((m: LearningMoment) => m.chatId === chatId)); setPopup(null); popupRef.current = null;
			if (readMomentSelection(document, chatId)) document.getSelection()?.removeAllRanges();
		} catch (error) { setError(error instanceof Error ? error.message : "Could not save this moment."); }
		finally { setSaving(false); }
	}

	return <MomentContext.Provider value={{ moments, edit }}>
		<div ref={scopeRef} className="contents" data-learning-chat-id={chatId}>{children}</div>
		<style>{`::highlight(${highlightName}) { background-color: color-mix(in oklab, var(--primary) 22%, transparent); text-decoration: underline; }`}</style>
		{popup && createPortal(<div data-learning-moment-ui data-testid="moment-annotation" className="lh-no-drag fixed z-[70] max-h-[calc(100dvh-24px)] max-w-[calc(100vw-24px)] overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-lg font-ui text-xs" style={{ left: popup.x, top: popup.y, width: popup.editing ? 340 : undefined }} onKeyDown={e => e.stopPropagation()}>
			{!popup.editing ? <div role="toolbar" aria-label="Selected passage actions"><button type="button" className="inline-flex min-h-10 items-center gap-2 px-3 py-2 hover:bg-accent" onPointerDown={e => e.preventDefault()} onClick={() => { setNote(popup.marker?.note ?? ""); setError(null); setPopup({ ...popup, editing: true }); }}><BookmarkPlusIcon className="size-3.5" />{popup.marker ? "Edit marked passage" : "Mark this moment"}</button></div> :
			<div role="dialog" aria-label="Mark selected passage" className="p-4">
				<div className="flex items-center justify-between gap-2"><p>{popup.marker ? "Your marked moment" : "Mark this moment"}</p><button type="button" aria-label="Close moment annotation" className="rounded p-1 hover:bg-accent" onClick={() => setPopup(null)}><XIcon className="size-4" /></button></div>
				{popup.excerpt ? <p className="my-3 max-h-32 overflow-y-auto border-l-2 pl-3 font-prose text-base whitespace-pre-wrap">{popup.excerpt}</p> : <p className="my-3 font-prose text-sm text-muted-foreground">{popup.selection ? "This passage has changed since it was marked. Your marker is still saved." : "This earlier marker refers to the whole moment."}</p>}
				<label className="block">What helped? <span className="text-muted-foreground">(optional)</span><textarea maxLength={4000} className="mt-2 w-full rounded-md border bg-background p-2 font-prose text-lg" value={note} onChange={e => setNote(e.target.value)} rows={2} /></label>
				<div className="mt-3 flex flex-wrap gap-2">{momentKinds.map(kind => <button type="button" disabled={saving} key={kind} className={`${actionClass} ${kind === "clicked" ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}`} onClick={() => void save(kind)}>{momentLabels[kind]}</button>)}</div>
				{popup.marker && <div className="mt-3 border-t pt-3"><p className="text-muted-foreground">Marked by you {new Date(popup.marker.createdAt).toLocaleString()}</p><button type="button" disabled={saving} className="mt-2 rounded-md py-1 underline" onClick={() => void save(null)}>Remove marker</button></div>}
				{error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
			</div>}
		</div>, document.body)}
	</MomentContext.Provider>;
}

/** Saved annotations remain keyboard-accessible even without CSS Highlights.
 * New markers are created by selecting text, instead of a whole-message button. */
export function MarkLearningMoment({ messageId }: { messageId: string }) {
	const context = useContext(MomentContext);
	const markers = context?.moments.filter(m => m.messageId === messageId) ?? [];
	if (!context || !markers.length) return null;
	return <div className="lh-no-drag my-2 flex flex-wrap gap-2 font-ui text-xs" data-learning-moment-ui data-testid="learning-moment">
		{markers.map((marker, index) => <button type="button" key={marker.id} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => context.edit(marker)}><CheckIcon className="size-3" />{momentLabels[marker.kind]} · {marker.selection ? `passage ${index + 1}` : "whole moment"}</button>)}
	</div>;
}
