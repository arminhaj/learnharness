"use client";

/* eslint-disable @next/next/no-img-element -- previews are SVGs generated locally from molecular sources. */

import { useEffect, useRef, useState, type DragEvent } from "react";
import { moleculeInput, type MoleculeReference, type MoleculeSource } from "@/src/core";
import { copyText } from "@/components/copy-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { drawMolecule } from "./rdkit-client";

export const MOLECULE_DRAG_MIME = "application/x-learnharness-molecule";
export type MoleculeDragPayload = { type: "selection"; token: string } | { type: "reference"; id: string };
export interface SelectedReferenceMolecule { token: string; source: MoleculeSource }

/** Drag only opaque internal identifiers. The editor resolves and validates them. */
export function readMoleculeDrag(transfer: Pick<DataTransfer, "getData">): MoleculeDragPayload | null {
	try {
		const raw = transfer.getData(MOLECULE_DRAG_MIME);
		if (!raw || raw.length > 1_024) return null;
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const item = value as Record<string, unknown>;
		const field = item.type === "selection" ? "token" : item.type === "reference" ? "id" : null;
		if (!field || Object.keys(item).some(key => key !== "type" && key !== field)) return null;
		const id = item[field];
		if (typeof id !== "string" || !id.trim() || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) return null;
		return item.type === "selection" ? { type: "selection", token: id } : { type: "reference", id };
	} catch { return null; }
}

export function writeMoleculeDrag(transfer: Pick<DataTransfer, "setData" | "effectAllowed">, payload: MoleculeDragPayload): void {
	transfer.setData(MOLECULE_DRAG_MIME, JSON.stringify(payload));
	transfer.effectAllowed = "copy";
}

function MoleculePreview({ source, name, payload, disabled, onError, compact = false }: {
	source: MoleculeSource;
	name: string;
	payload: MoleculeDragPayload;
	disabled: boolean;
	onError: (message: string) => void;
	compact?: boolean;
}) {
	const [svg, setSvg] = useState<string>();
	const [failed, setFailed] = useState(false);
	const input = JSON.stringify(source);
	useEffect(() => {
		let current = true;
		setSvg(undefined); setFailed(false);
		void drawMolecule(JSON.parse(input) as MoleculeSource).then(
			value => { if (current) setSvg(value); },
			() => { if (current) setFailed(true); },
		);
		return () => { current = false; };
	}, [input]);
	return <div role="group" aria-label={`Drag ${name} into drawing`} title="Drag this preview to copy the molecule" draggable={!disabled}
		className={`flex items-center justify-center rounded border bg-white p-2 text-xs text-gray-600 ${compact ? "h-20 w-32 shrink-0" : "h-28 w-full"} ${disabled ? "opacity-60" : "cursor-grab active:cursor-grabbing"}`}
		aria-busy={!svg && !failed}
		onDragStart={event => {
			if (disabled) { event.preventDefault(); return; }
			event.stopPropagation();
			try { writeMoleculeDrag(event.dataTransfer, payload); }
			catch { event.preventDefault(); onError("Could not start dragging. Use Paste into drawing instead."); }
		}}>
		{svg ? <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={`${name} structure`} draggable={false} className="h-full w-full object-contain" />
			: failed ? <span>Preview unavailable</span> : <span>Drawing molecule…</span>}
	</div>;
}

interface ReferenceCardProps {
	reference: MoleculeReference;
	editable: boolean;
	disabled: boolean;
	onCopy: () => void;
	onInsert: () => void;
	onRename: (name: string) => Promise<boolean>;
	onRemove: () => void;
	onError: (message: string) => void;
}

function ReferenceCard({ reference, editable, disabled, onCopy, onInsert, onRename, onRemove, onError }: ReferenceCardProps) {
	const [renaming, setRenaming] = useState(false);
	const [name, setName] = useState(reference.name);
	useEffect(() => { setName(reference.name); }, [reference.name]);
	const rename = async () => {
		if (disabled) return;
		if (!name.trim()) { onError("Enter a name for this intermediate."); return; }
		if (await onRename(name.trim())) setRenaming(false);
	};
	return <article className="space-y-2 rounded-md border bg-background p-2" aria-label={reference.name}>
		{renaming ? <div className="space-y-1.5">
			<Input type="text" aria-label={`Name for ${reference.name}`} value={name} maxLength={120} disabled={disabled} onChange={event => setName(event.target.value)} onKeyDown={event => {
				if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void rename(); }
				if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setName(reference.name); setRenaming(false); }
			}} />
			<div className="flex gap-1"><Button type="button" size="xs" disabled={disabled} onClick={() => void rename()}>Save name</Button><Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => { setName(reference.name); setRenaming(false); }}>Cancel rename</Button></div>
		</div> : <p className="break-words text-sm font-medium">{reference.name}</p>}
		<MoleculePreview source={reference.source} name={reference.name} payload={{ type: "reference", id: reference.id }} disabled={disabled} onError={onError} />
		<div className="flex flex-wrap gap-1">
			<Button type="button" variant="outline" size="xs" disabled={disabled} aria-label={`Copy ${reference.name}`} onClick={onCopy}>Copy</Button>
			<Button type="button" variant="outline" size="xs" disabled={disabled} aria-label={`Paste ${reference.name} into drawing`} onClick={onInsert}>Paste into drawing</Button>
			{editable && <><Button type="button" variant="ghost" size="xs" disabled={disabled || renaming} aria-label={`Rename ${reference.name}`} onClick={() => { setName(reference.name); setRenaming(true); }}>Rename</Button>
				<Button type="button" variant="ghost" size="xs" disabled={disabled} aria-label={`Remove ${reference.name}`} onClick={onRemove}>Remove</Button></>}
		</div>
	</article>;
}

export interface MoleculeReferenceSidebarProps {
	problemReferences: MoleculeReference[];
	savedReferences: MoleculeReference[];
	onInsert: (source: MoleculeSource, point?: { clientX: number; clientY: number }) => Promise<void>;
	onSaveSelected: () => Promise<void>;
	onRenameReference: (id: string, name: string) => void;
	onRemoveReference: (id: string) => void;
	onReferenceDrop: (token: string) => void | Promise<void>;
	selected?: SelectedReferenceMolecule;
	disabled: boolean;
}

export function MoleculeReferenceSidebar({ problemReferences, savedReferences, onInsert, onSaveSelected, onRenameReference, onRemoveReference, onReferenceDrop, selected, disabled }: MoleculeReferenceSidebarProps) {
	const [working, setWorking] = useState(false);
	const [error, setError] = useState<string>();
	const [status, setStatus] = useState<string>();
	const [dragOver, setDragOver] = useState(false);
	const pending = useRef(false);
	const mounted = useRef(true);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const run = async (message: string, action: () => void | Promise<void>): Promise<boolean> => {
		if (disabled || pending.current) return false;
		pending.current = true;
		setWorking(true); setError(undefined); setStatus(undefined);
		try {
			await action();
			if (mounted.current) setStatus(message);
			return true;
		} catch (reason) {
			if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not update the reference molecules. Try again.");
			return false;
		} finally {
			pending.current = false;
			if (mounted.current) setWorking(false);
		}
	};
	const card = (reference: MoleculeReference, editable: boolean) => <ReferenceCard key={reference.id} reference={reference} editable={editable} disabled={disabled || working}
		onError={setError}
		onCopy={() => void run(`Copied ${reference.name}.`, async () => {
			if (!await copyText(moleculeInput(reference.source))) throw new Error("Could not copy this molecule. Use Paste into drawing instead.");
		})}
		onInsert={() => void run(`Pasted ${reference.name} into the drawing.`, () => onInsert(reference.source))}
		onRename={name => run("Intermediate renamed.", () => onRenameReference(reference.id, name))}
		onRemove={() => void run(`Removed ${reference.name} from My intermediates.`, () => onRemoveReference(reference.id))} />;
	const internalDrag = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types ?? []).includes(MOLECULE_DRAG_MIME);
	return <aside aria-label="Molecule references" data-testid="molecule-reference-sidebar" aria-busy={working}
		className={`min-w-0 space-y-3 rounded-md border p-3 lg:w-[260px] lg:max-w-[280px] lg:shrink-0 ${dragOver ? "border-primary bg-accent/40" : ""}`}
		onKeyDown={event => event.stopPropagation()}
		onDragOver={event => {
			if (!internalDrag(event) || disabled || working) return;
			event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; setDragOver(true);
		}}
		onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }}
		onDrop={event => {
			if (!internalDrag(event)) return;
			event.preventDefault(); event.stopPropagation(); setDragOver(false);
			if (disabled || working) return;
			const payload = readMoleculeDrag(event.dataTransfer);
			if (payload?.type === "selection") void run("Saved selected molecule to My intermediates.", () => onReferenceDrop(payload.token));
		}}>
		<h3 className="text-sm font-semibold">Reference molecules</h3>
		<div className="max-h-[min(62vh,620px)] space-y-4 overflow-y-auto">
			<section aria-label="Problem structures" className="space-y-2"><h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem structures</h4>
				{problemReferences.length ? problemReferences.map(reference => card(reference, false)) : <p className="text-xs text-muted-foreground">No problem structures provided.</p>}
			</section>
			<section aria-label="My intermediates" className="space-y-2"><h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">My intermediates</h4>
				<Button type="button" variant="outline" size="sm" className="w-full" disabled={disabled || working || !selected} onClick={() => void run("Saved selected molecule to My intermediates.", onSaveSelected)}>Save selected molecule</Button>
				<p className="text-xs text-muted-foreground">Drag a selected molecule here to save it. Drag a preview into the drawing to reuse a copy.</p>
				{savedReferences.map(reference => card(reference, true))}
			</section>
		</div>
		{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
		{status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}
	</aside>;
}

export function SelectedMoleculeDrag({ selected, disabled }: { selected?: SelectedReferenceMolecule; disabled: boolean }) {
	const [copying, setCopying] = useState(false);
	const [error, setError] = useState<string>();
	const [copied, setCopied] = useState(false);
	const mounted = useRef(true);
	const pendingCopy = useRef(false);
	const token = useRef(selected?.token);
	token.current = selected?.token;
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	useEffect(() => { setError(undefined); setCopied(false); }, [selected?.token]);
	if (!selected) return null;
	return <div className="flex flex-wrap items-center gap-2" data-testid="selected-molecule-drag" onKeyDown={event => event.stopPropagation()}>
		<MoleculePreview source={selected.source} name="Selected molecule" payload={{ type: "selection", token: selected.token }} disabled={disabled || copying} onError={setError} compact />
		<div className="space-y-1"><p className="text-xs text-muted-foreground">Drag this selection to My intermediates or another drawing.</p>
			<Button type="button" variant="outline" size="sm" disabled={disabled || copying} onClick={() => {
				if (disabled || pendingCopy.current) return;
				pendingCopy.current = true;
				const captured = selected;
				setCopying(true); setError(undefined); setCopied(false);
				void (async () => {
					try {
						if (!await copyText(moleculeInput(captured.source))) throw new Error("Could not copy the selection. Drag its preview instead.");
						if (mounted.current && token.current === captured.token) setCopied(true);
					} catch (reason) {
						if (mounted.current && token.current === captured.token) setError(reason instanceof Error ? reason.message : "Could not copy the selection.");
					} finally { pendingCopy.current = false; if (mounted.current) setCopying(false); }
				})();
			}}>{copying ? "Copying…" : "Copy selected"}</Button>
			{copied && <p role="status" className="text-xs text-muted-foreground">Selection copied.</p>}
		</div>
		{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
	</div>;
}
