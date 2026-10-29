"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRightIcon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { propositionSessionHref } from "@/src/core";
import type { ProvenancePoint } from "@/src/core";
import type { LearningConcept, LearningGraphSnapshot, LearningNodePatch, LearningPrerequisitePatch, LearningProgress, LearningSymbol } from "@/src/core";
import { LEARNING_PROGRESS_LABELS, LearningProgressDot } from "./learning-iceberg.tsx";

const fieldClass = "min-h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors focus:border-foreground/60 disabled:opacity-50";
const actionClass = "inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 py-2 text-xs transition-colors hover:bg-accent focus-visible:bg-accent disabled:opacity-40";

type LearningMetadataDirtyFields = Partial<Record<"name" | "tags" | "symbols", true>>;

/** Editing a name must not freeze automatic symbols or tags as a side effect. */
export function learningMetadataPatch(draft: { name: string; tags: string; symbols: LearningSymbol[] }, dirty: LearningMetadataDirtyFields): LearningNodePatch {
	const patch: LearningNodePatch = {};
	if (dirty.name) patch.name = draft.name.trim();
	if (dirty.tags) patch.tags = [...new Set(draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean))];
	if (dirty.symbols) patch.symbols = draft.symbols.map((symbol) => ({ ...symbol, notation: symbol.notation.trim(), meaning: symbol.meaning.trim(), aliases: [...new Set(symbol.aliases.map((alias) => alias.trim()).filter(Boolean))] }));
	return patch;
}

export interface LearningNodeSidebarProps {
	node: LearningConcept;
	learning: LearningGraphSnapshot;
	onClose: () => void;
	onSelect: (id: string) => void;
	onSave: (patch: LearningNodePatch) => Promise<void>;
	onPrerequisiteChange: (patch: LearningPrerequisitePatch) => Promise<void>;
	sessions?: Record<string, string>;
	fileSources?: Record<string, string>;
	className?: string;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return <section className="border-t border-border/60 py-4"><h3 className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">{title}</h3>{children}</section>;
}

function SourceLinks({ provenance, sessions, fileSources }: { provenance: ProvenancePoint[]; sessions: Record<string, string>; fileSources: Record<string, string> }) {
	const sources = [...new Set(provenance.map((source) => source.chatId))];
	return <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{sources.map((sourceId) => fileSources[sourceId] !== undefined
		? <span key={sourceId} className="break-all text-xs text-muted-foreground">{fileSources[sourceId]}</span>
		: sessions[sourceId] !== undefined ? <Link key={sourceId} scroll={false} href={propositionSessionHref({ provenance }, sourceId)} className="inline-flex min-h-7 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:underline">{sessions[sourceId]}<ArrowUpRightIcon className="size-3 shrink-0" aria-hidden="true" /></Link>
		: <span key={sourceId} className="text-xs text-muted-foreground">Source unavailable</span>)}</div>;
}

function displayDate(value: string | null): string {
	if (!value) return "Not encountered yet";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The parent keys this panel by node id; background assessments never replace
 * a dirty metadata draft. All writes finish before the panel reports success. */
export function LearningNodeSidebar({ node, learning, onClose, onSelect, onSave, onPrerequisiteChange, sessions = {}, fileSources = {}, className }: LearningNodeSidebarProps) {
	const titleId = useId();
	const closeRef = useRef<HTMLButtonElement>(null);
	const [name, setName] = useState(node.name);
	const [tags, setTags] = useState(node.tags.join(", "));
	const [symbols, setSymbols] = useState<LearningSymbol[]>(node.symbols);
	const [dirtyFields, setDirtyFields] = useState<LearningMetadataDirtyFields>({});
	const dirty = Object.keys(dirtyFields).length > 0;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [prerequisiteId, setPrerequisiteId] = useState("");
	const [reason, setReason] = useState("");
	const nodes = new Map(learning.nodes.map((value) => [value.id, value]));
	const prerequisites = learning.prerequisites.filter((edge) => edge.to === node.id);
	const corrections = learning.prerequisiteCorrections.filter((edge) => edge.to === node.id);
	const following = learning.prerequisites.filter((edge) => edge.from === node.id).map((edge) => nodes.get(edge.to)).filter((value) => value !== undefined);
	const candidates = learning.nodes.filter((value) => value.id !== node.id && !prerequisites.some((edge) => edge.from === value.id)).sort((a, b) => a.name.localeCompare(b.name));

	useEffect(() => {
		if (!dirtyFields.name) setName(node.name);
		if (!dirtyFields.tags) setTags(node.tags.join(", "));
		if (!dirtyFields.symbols) setSymbols(node.symbols);
	}, [node.name, node.tags, node.symbols, dirtyFields]);
	useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, []);
	useEffect(() => {
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); onClose(); }
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [onClose]);

	async function run(action: () => Promise<void>, success: string) {
		if (busy) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try { await action(); setNotice(success); }
		catch (failure) { setError(failure instanceof Error ? failure.message : "The update could not be saved. Please try again."); }
		finally { setBusy(false); }
	}
	function editSymbol(index: number, patch: Partial<LearningSymbol>) {
		setSymbols((current) => current.map((symbol, i) => i === index ? { ...symbol, ...patch } : symbol));
		setDirtyFields((fields) => ({ ...fields, symbols: true }));
	}

	return (
		<aside aria-labelledby={titleId} data-testid="learning-node-sidebar" onPointerDown={(event) => event.stopPropagation()} className={cn("lh-no-drag flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card text-left shadow-lg", className)}>
			<header className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
				<div className="min-w-0"><p className="text-xs uppercase tracking-wider text-muted-foreground">Concept details</p><h2 id={titleId} className="mt-1 break-words font-title text-xl">{node.name}</h2></div>
				<button ref={closeRef} type="button" aria-label="Close concept details" onClick={onClose} className={cn(actionClass, "-mr-2 shrink-0 px-2")}><XIcon className="size-4" /></button>
			</header>
			<div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-2">
				<p className="py-4 font-prose text-base leading-relaxed text-muted-foreground">{node.statement}</p>
				{node.future && <p className="mb-4 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">On your subject map. Not encountered in a conversation yet.</p>}
				<Section title="Your understanding">
					<div className="flex items-center gap-3">
						<LearningProgressDot progress={node.progress} />
						<label className="sr-only" htmlFor={`${titleId}-progress`}>Understanding</label>
						<select id={`${titleId}-progress`} value={node.progress} disabled={busy} onChange={(event) => void run(() => onSave({ progress: event.target.value as LearningProgress }), "Understanding corrected.")} className={fieldClass}>
							{(["unassessed", "learning", "comfortable"] as const).map((progress) => <option key={progress} value={progress}>{LEARNING_PROGRESS_LABELS[progress]}</option>)}
						</select>
					</div>
					<p className="mt-2 text-xs leading-relaxed text-muted-foreground">{node.progressOverride !== null ? "Your correction is active. Automatic assessments will not replace it." : node.progressEvidence.length ? "Automatically assessed from your learning evidence. You can correct this at any time." : "No understanding evidence yet. Encountering a concept alone does not establish understanding."}</p>
					{node.progressOverride !== null && <button type="button" disabled={busy} onClick={() => void run(() => onSave({ progress: null }), "Following automatic assessments.")} className={cn(actionClass, "mt-1 -ml-3 text-muted-foreground")}><RotateCcwIcon aria-hidden="true" className="size-3" />Use automatic · {LEARNING_PROGRESS_LABELS[node.automaticProgress]}</button>}
					{node.progressEvidence.length > 0 && <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Why this assessment?</summary><ol className="mt-2 space-y-3">{[...node.progressEvidence].reverse().slice(0, 5).map((evidence, index) => <li key={`${evidence.observedAt}-${index}`} className="border-l border-border pl-3"><p className="text-xs text-muted-foreground">{LEARNING_PROGRESS_LABELS[evidence.state]} · {displayDate(evidence.observedAt)}</p><p className="mt-1 font-prose text-sm leading-relaxed">{evidence.explanation}</p><SourceLinks provenance={evidence.provenance} sessions={sessions} fileSources={fileSources} /></li>)}</ol></details>}
				</Section>
				<Section title="Readiness & prerequisites">
					<p className="font-prose text-sm leading-relaxed">{node.progress === "comfortable" ? "You are comfortable with this concept." : node.ready ? prerequisites.length ? "Ready to learn: all recorded prerequisites are comfortable." : "Ready to begin: no prerequisites recorded." : `${node.unmetPrerequisiteIds.length} ${node.unmetPrerequisiteIds.length === 1 ? "prerequisite needs" : "prerequisites need"} more understanding.`}</p>
					<p className="mt-1 text-xs leading-relaxed text-muted-foreground">An arrow means “learn this before that.” Readiness depends on the connections recorded here.</p>
					{prerequisites.length === 0 && <p className="mt-3 text-xs text-muted-foreground">No prerequisites recorded.</p>}
					<ul className="mt-2 space-y-3">{prerequisites.map((edge) => {
						const prerequisite = nodes.get(edge.from);
						if (!prerequisite) return null;
						const correction = corrections.find((value) => value.from === edge.from);
						return <li key={edge.id} className="rounded-md border border-border/60 p-3">
							<button type="button" onClick={() => onSelect(prerequisite.id)} className="flex min-h-8 items-center gap-2 text-left font-prose text-sm hover:underline focus-visible:underline"><LearningProgressDot progress={prerequisite.progress} />{prerequisite.name}<span className="sr-only">, {LEARNING_PROGRESS_LABELS[prerequisite.progress]}</span></button>
							<p className="mt-1 font-prose text-sm leading-relaxed text-muted-foreground">{edge.explanation}</p>
							<SourceLinks provenance={edge.provenance} sessions={sessions} fileSources={fileSources} />
							<div className="mt-1 flex flex-wrap items-center justify-between gap-1"><span className="text-xs text-muted-foreground">{edge.origin === "manual" ? "Your connection" : "Automatic connection"}</span><button type="button" disabled={busy} aria-label={`Remove prerequisite ${prerequisite.name}`} onClick={() => void run(() => onPrerequisiteChange({ from: edge.from, to: edge.to, enabled: false }), "Prerequisite removed. Your correction is saved.")} className={cn(actionClass, "-mr-2 text-muted-foreground")}>Remove</button></div>
							{correction && <button type="button" disabled={busy} onClick={() => void run(() => onPrerequisiteChange({ from: edge.from, to: edge.to, enabled: null }), "Following the automatic connection.")} className={cn(actionClass, "-ml-3 text-muted-foreground")}><RotateCcwIcon className="size-3" aria-hidden="true" />Use automatic</button>}
						</li>;
					})}</ul>
					{corrections.some((edge) => edge.enabled === false) && <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">Removed prerequisites</summary>{corrections.filter((edge) => edge.enabled === false).map((edge) => <div key={edge.from} className="mt-2 flex items-center justify-between gap-2 text-xs"><span>{nodes.get(edge.from)?.name ?? edge.from}</span><button type="button" disabled={busy} className={actionClass} onClick={() => void run(() => onPrerequisiteChange({ ...edge, enabled: null }), "Following the automatic connection.")}>Use automatic</button></div>)}</details>}
					{adding ? <form className="mt-3 space-y-2 rounded-md border border-border/60 p-3" onSubmit={(event) => { event.preventDefault(); if (prerequisiteId) void run(async () => { await onPrerequisiteChange({ from: prerequisiteId, to: node.id, enabled: true, explanation: reason.trim() || undefined }); setAdding(false); setPrerequisiteId(""); setReason(""); }, "Prerequisite added. Your correction is saved."); }}>
						<label htmlFor={`${titleId}-prerequisite`} className="block text-xs text-muted-foreground">Learn first</label>
						<select id={`${titleId}-prerequisite`} value={prerequisiteId} onChange={(event) => setPrerequisiteId(event.target.value)} className={fieldClass} required disabled={busy}><option value="">Choose a concept</option>{candidates.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select>
						<label htmlFor={`${titleId}-reason`} className="block text-xs text-muted-foreground">Why it helps (optional)</label>
						<textarea id={`${titleId}-reason`} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} className={fieldClass} disabled={busy} />
						<div className="flex justify-end gap-1"><button type="button" disabled={busy} onClick={() => setAdding(false)} className={actionClass}>Cancel</button><button type="submit" disabled={busy || !prerequisiteId} className={cn(actionClass, "border border-border")}>Add prerequisite</button></div>
					</form> : <button type="button" disabled={busy || candidates.length === 0} onClick={() => setAdding(true)} className={cn(actionClass, "mt-2 -ml-3")}><PlusIcon aria-hidden="true" className="size-3" />Add prerequisite</button>}
					{following.length > 0 && <div className="mt-3"><p className="text-xs text-muted-foreground">Helps unlock</p>{following.map((next) => <button type="button" key={next.id} onClick={() => onSelect(next.id)} className="mt-1 flex min-h-8 items-center gap-2 text-left font-prose text-sm hover:underline focus-visible:underline"><ArrowUpRightIcon aria-hidden="true" className="size-3 shrink-0" />{next.name}<span className="text-xs text-muted-foreground">{next.ready && next.progress !== "comfortable" ? "Ready" : ""}</span></button>)}</div>}
				</Section>
				<form onSubmit={(event) => { event.preventDefault(); if (name.trim()) void run(async () => { await onSave(learningMetadataPatch({ name, tags, symbols }, dirtyFields)); setDirtyFields({}); }, "Node details saved."); }}>
					<Section title="Name & tags">
						<label htmlFor={`${titleId}-name`} className="mb-1 block text-xs text-muted-foreground">Name</label>
						<input id={`${titleId}-name`} required maxLength={200} value={name} onChange={(event) => { setName(event.target.value); setDirtyFields((fields) => ({ ...fields, name: true })); }} className={fieldClass} disabled={busy} />
						<label htmlFor={`${titleId}-tags`} className="mb-1 mt-3 block text-xs text-muted-foreground">Tags · separated by commas</label>
						<input id={`${titleId}-tags`} value={tags} onChange={(event) => { setTags(event.target.value); setDirtyFields((fields) => ({ ...fields, tags: true })); }} placeholder="Mechanics, variational methods" className={fieldClass} disabled={busy} />
					</Section>
					<Section title="Introduced symbols">
						<p className="mb-3 text-xs leading-relaxed text-muted-foreground">Search by notation, meaning, or an alias such as γ, \gamma, or gamma.</p>
						{symbols.length === 0 && <p className="text-xs text-muted-foreground">No symbols recorded.</p>}
						<div className="space-y-3">{symbols.map((symbol, index) => <div key={index} className="space-y-2 rounded-md border border-border/60 p-3">
							<div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Symbol {index + 1}</span><button type="button" aria-label={`Remove symbol ${symbol.notation || index + 1}`} disabled={busy} onClick={() => { setSymbols((current) => current.filter((_, i) => i !== index)); setDirtyFields((fields) => ({ ...fields, symbols: true })); }} className={cn(actionClass, "-mr-2 px-2")}><XIcon aria-hidden="true" className="size-3" /></button></div>
							<label className="block text-xs text-muted-foreground">Notation<input aria-label={`Symbol ${index + 1} notation`} required value={symbol.notation} onChange={(event) => editSymbol(index, { notation: event.target.value })} placeholder="γ" className={cn(fieldClass, "mt-1")} disabled={busy} /></label>
							<label className="block text-xs text-muted-foreground">Meaning<input aria-label={`Symbol ${index + 1} meaning`} required value={symbol.meaning} onChange={(event) => editSymbol(index, { meaning: event.target.value })} placeholder="Exponential growth factor" className={cn(fieldClass, "mt-1")} disabled={busy} /></label>
							<label className="block text-xs text-muted-foreground">Aliases · separated by commas<input aria-label={`Symbol ${index + 1} aliases`} value={symbol.aliases.join(",")} onChange={(event) => editSymbol(index, { aliases: event.target.value.split(",") })} placeholder="\gamma, gamma" className={cn(fieldClass, "mt-1")} disabled={busy} /></label>
							<SourceLinks provenance={symbol.provenance} sessions={sessions} fileSources={fileSources} />
						</div>)}</div>
						<button type="button" disabled={busy} onClick={() => { setSymbols((current) => [...current, { notation: "", meaning: "", aliases: [], provenance: [] }]); setDirtyFields((fields) => ({ ...fields, symbols: true })); }} className={cn(actionClass, "mt-2 -ml-3")}><PlusIcon aria-hidden="true" className="size-3" />Add symbol</button>
					</Section>
					<div className="flex items-center justify-between gap-2 pb-4"><button type="button" disabled={busy} onClick={() => void run(async () => { await onSave({ name: null, tags: null, symbols: null }); setDirtyFields({}); }, "Following automatic metadata.")} className={cn(actionClass, "-ml-3 text-muted-foreground")}><RotateCcwIcon aria-hidden="true" className="size-3" />Reset metadata</button><button type="submit" disabled={busy || !dirty || !name.trim()} className={cn(actionClass, "border border-border bg-accent/50")}>{busy ? "Saving…" : "Save details"}</button></div>
				</form>
				<Section title="History & sources">
					<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs"><dt className="text-muted-foreground">Added to map</dt><dd>{displayDate(node.createdAt)}</dd><dt className="text-muted-foreground">First encountered</dt><dd>{displayDate(node.firstEncounteredAt)}</dd></dl>
					{node.provenance.length > 0 ? <div className="mt-3"><SourceLinks provenance={node.provenance} sessions={sessions} fileSources={fileSources} /></div> : <p className="mt-3 text-xs text-muted-foreground">No conversation sources yet.</p>}
				</Section>
			</div>
			{(error || notice || dirty) && <div className="shrink-0 border-t border-border/60 px-4 py-3 text-xs"><p role={error ? "alert" : "status"} className={error ? "text-destructive" : "text-muted-foreground"}>{error ?? (dirty ? "You have unsaved changes to node details." : notice)}</p></div>}
		</aside>
	);
}
