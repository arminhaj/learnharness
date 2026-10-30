"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConformerResult, MoleculeConformer, MoleculeSource } from "@/src/core";
import { viewerFrameHtml } from "./viewer-frame";

/** Only the backend's eligible, geometrically validated rings get a label.
 * An empty ring list means unclassified, never an inferred chair. */
function ringLabel(conformer: MoleculeConformer): string {
	const rings = conformer.rings;
	if (!rings.length) return "";
	if (rings.length === 1) return rings[0]!.shape;
	return (["chair", "non-chair", "near-planar"] as const)
		.map(shape => ({ shape, count: rings.filter(ring => ring.shape === shape).length }))
		.filter(({ count }) => count > 0)
		.map(({ shape, count }) => `${count} ${shape} ring${count === 1 ? "" : "s"}`)
		.join(", ");
}

/** The backend owns group recognition and geometry. Never extend a chair
 * summary to other shapes or imply atom numbering from its stable indices. */
function substituentLabel(conformer: MoleculeConformer, abbreviated = true): string {
	const ring = conformer.rings.length === 1 ? conformer.rings[0] : undefined;
	if (ring?.shape !== "chair" || !ring.substituents?.length) return "";
	return ring.substituents.map(({ label, orientation }) =>
		`${label} ${abbreviated ? orientation === "axial" ? "ax." : "eq." : orientation}`,
	).join(", ");
}

type SearchResponse = { sourceKey: string; requestId: number; result: ConformerResult };
type ViewerError = { sourceKey: string; message: string };

export default function Molecule3D({ source }: { source: MoleculeSource }) {
	const id = useId();
	const channel = `lh-chemistry-3d-${id}`;
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const sidebarRef = useRef<HTMLElement>(null);
	const sidebarToggleRef = useRef<HTMLButtonElement>(null);
	const choiceRefs = useRef(new Map<string, HTMLButtonElement>());
	const requestSequence = useRef(0);
	const [attempt, setAttempt] = useState(0);
	const [frameReady, setFrameReady] = useState(false);
	const [renderedId, setRenderedId] = useState<string | null>(null);
	const [response, setResponse] = useState<SearchResponse | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [errorState, setError] = useState<ViewerError | null>(null);
	const [style, setStyle] = useState<"balls" | "sticks">("balls");
	const [searchedSource, setSearchedSource] = useState<string | null>(null);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const styleRef = useRef(style);
	styleRef.current = style;
	const sourceKey = JSON.stringify(source);
	const searchRequested = searchedSource === sourceKey;
	const current = response?.sourceKey === sourceKey ? response : null;
	const result = current?.result;
	const candidates = useMemo(() => [...(result?.conformers ?? [])].sort((a, b) => a.relativeEnergy - b.relativeEnergy), [result]);
	const selected = candidates.find(candidate => candidate.id === selectedId) ?? candidates[0];
	const selectedSdf = selected?.sdf ?? result?.sdf;
	const modelId = current && selectedSdf ? `${channel}:${current.requestId}:${selected?.id ?? "imported"}` : null;
	const modelIdRef = useRef(modelId);
	modelIdRef.current = modelId;
	const sourceKeyRef = useRef(sourceKey);
	sourceKeyRef.current = sourceKey;
	const rendered = modelId !== null && renderedId === modelId;
	const error = errorState?.sourceKey === sourceKey ? errorState.message : null;
	const frame = useMemo(() => typeof window === "undefined" ? "" : viewerFrameHtml(`${window.location.origin}/chemistry/3Dmol-min.js`, channel), [channel]);

	useEffect(() => { setSearchedSource(null); }, [sourceKey]);

	useEffect(() => {
		const controller = new AbortController();
		const requestId = ++requestSequence.current;
		setError(null);
		setResponse(null);
		setSelectedId(null);
		setRenderedId(null);
		modelIdRef.current = null;
		iframeRef.current?.contentWindow?.postMessage({ channel, type: "clear" }, "*");
		// Every source is checked by the endpoint. A search explicitly replaces
		// imported coordinates with a ranked ensemble from the same molecule.
		const payload = searchRequested ? JSON.stringify({ ...JSON.parse(sourceKey), search: true }) : sourceKey;
		void fetch("/api/chemistry/conformer", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: controller.signal })
			.then(async (httpResponse) => {
				const result: ConformerResult & { error?: string } = await httpResponse.json();
				if (!httpResponse.ok) throw new Error(result.error || "Could not generate a 3D model.");
				if (typeof result.sdf !== "string" || !result.sdf.trim()) throw new Error("The chemistry service did not return molecular coordinates.");
				if (!controller.signal.aborted && requestId === requestSequence.current) setResponse({ sourceKey, requestId, result });
			})
			.catch((e) => {
				if (!controller.signal.aborted && requestId === requestSequence.current) setError({ sourceKey, message: e instanceof Error ? e.message : "Could not generate a 3D model." });
			});
		return () => controller.abort();
	}, [sourceKey, searchRequested, attempt, channel]);

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (event.source !== iframeRef.current?.contentWindow || event.data?.channel !== channel) return;
			if (event.data.type === "ready") { setFrameReady(true); return; }
			// Old render/error acknowledgements must never complete a newer
			// conformer, source, or retry. Commands and replies share this ID.
			if (!modelIdRef.current || event.data.modelId !== modelIdRef.current) return;
			if (event.data.type === "rendered") setRenderedId(event.data.modelId);
			if (event.data.type === "error") setError({ sourceKey: sourceKeyRef.current, message: String(event.data.error) });
		};
		window.addEventListener("message", receive);
		return () => window.removeEventListener("message", receive);
	}, [channel]);

	useEffect(() => {
		if (frameReady) return;
		const timer = setTimeout(() => setError({ sourceKey, message: "The 3D viewer did not initialize. Try opening it again." }), 15000);
		return () => clearTimeout(timer);
	}, [frameReady, attempt, sourceKey]);

	useEffect(() => {
		if (!frameReady || !modelId || rendered) return;
		const timer = setTimeout(() => {
			if (modelIdRef.current === modelId) setError({ sourceKey, message: "The molecular model could not be displayed. WebGL may be unavailable." });
		}, 15000);
		return () => clearTimeout(timer);
	}, [frameReady, modelId, rendered, sourceKey]);

	useEffect(() => {
		if (frameReady && modelId && selectedSdf) iframeRef.current?.contentWindow?.postMessage({ channel, type: "model", modelId, group: current!.requestId, sdf: selectedSdf, style: styleRef.current }, "*");
	}, [frameReady, modelId, selectedSdf, channel, current]);

	useEffect(() => {
		const element = iframeRef.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => element.contentWindow?.postMessage({ channel, type: "resize", modelId: modelIdRef.current }, "*"));
		observer.observe(element);
		return () => observer.disconnect();
	}, [channel, attempt]);

	const command = (message: Record<string, unknown>) => iframeRef.current?.contentWindow?.postMessage({ channel, modelId: modelIdRef.current, ...message }, "*");
	const selectStyle = (next: "balls" | "sticks") => { setStyle(next); command({ type: "style", style: next }); };
	const chooseConformer = (next: string) => {
		if (next === selected?.id) return;
		modelIdRef.current = null;
		setRenderedId(null);
		setError(null);
		setSelectedId(next);
	};
	const walkConformers = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
		let next: number;
		switch (event.key) {
			case "ArrowDown": case "ArrowRight": next = (index + 1) % candidates.length; break;
			case "ArrowUp": case "ArrowLeft": next = (index + candidates.length - 1) % candidates.length; break;
			case "Home": next = 0; break;
			case "End": next = candidates.length - 1; break;
			default: return;
		}
		event.preventDefault();
		const candidate = candidates[next]!;
		chooseConformer(candidate.id);
		const row = choiceRefs.current.get(candidate.id);
		row?.focus();
		row?.scrollIntoView?.({ block: "nearest" });
	};
	const toggleSidebar = () => {
		// A collapsing list cannot leave keyboard focus inside hidden content.
		if (sidebarOpen && sidebarRef.current?.contains(document.activeElement)) sidebarToggleRef.current?.focus();
		setSidebarOpen(open => !open);
	};

	return (
		<section data-testid="molecule-3d" data-chemistry-interactive="" className="space-y-3" aria-label={source.label ? `3D view of ${source.label}` : "3D molecular view"} onKeyDown={event => event.stopPropagation()}>
			<div className="flex flex-wrap items-center gap-2" aria-label="Model appearance">
				<Button type="button" size="sm" variant={style === "balls" ? "secondary" : "ghost"} aria-pressed={style === "balls"} onClick={() => selectStyle("balls")}>Ball and stick</Button>
				<Button type="button" size="sm" variant={style === "sticks" ? "secondary" : "ghost"} aria-pressed={style === "sticks"} onClick={() => selectStyle("sticks")}>Sticks</Button>
			</div>
			{selected && <p id={`${id}-conformer-details`} data-testid="conformer-details" role="status" className="text-sm">
				{result?.search?.method ? `${result.search.method} · ` : ""}ΔE {selected.relativeEnergy.toFixed(2)} kcal/mol{ringLabel(selected) ? ` · ${ringLabel(selected)}` : ""}
			</p>}
			<div data-testid="conformer-viewer-layout" className="flex min-w-0 flex-col overflow-hidden rounded-md border bg-background sm:h-[min(52vh,420px)] sm:min-h-[260px] sm:flex-row">
				{candidates.length > 0 && <aside key="conformer-sidebar" ref={sidebarRef} data-testid="conformer-sidebar" aria-label="Conformer selection" className={`flex min-h-0 min-w-0 shrink-0 flex-col border-b border-border sm:border-r sm:border-b-0 ${sidebarOpen ? "w-full sm:w-48" : "w-full sm:w-10"}`}>
					<div className={`flex min-h-10 shrink-0 items-center gap-2 ${sidebarOpen ? "justify-between px-2" : "justify-start px-1 sm:justify-center"}`}>
						{sidebarOpen && <span className="text-sm font-medium">Conformers</span>}
						<Button ref={sidebarToggleRef} type="button" variant="ghost" size="icon-sm" aria-label={sidebarOpen ? "Collapse conformers" : "Expand conformers"} aria-expanded={sidebarOpen} aria-controls={`${id}-conformers`} onClick={toggleSidebar}>
							{sidebarOpen ? <PanelLeftCloseIcon aria-hidden="true" /> : <PanelLeftOpenIcon aria-hidden="true" />}
						</Button>
					</div>
					<div id={`${id}-conformers`} hidden={!sidebarOpen} role="radiogroup" aria-label="Conformers by increasing relative energy" aria-describedby={`${id}-conformer-details`} className="min-h-0 max-h-40 overflow-y-auto px-1 pb-1 sm:max-h-none sm:flex-1">
						{candidates.map((candidate, index) => {
							const summary = substituentLabel(candidate);
							const expandedSummary = summary ? substituentLabel(candidate, false) : undefined;
							const label = summary || ringLabel(candidate);
							return <button key={candidate.id} type="button" role="radio" aria-label={expandedSummary ? `ΔE ${candidate.relativeEnergy.toFixed(2)} kcal/mol, ${expandedSummary}` : undefined} aria-checked={candidate.id === selected?.id} tabIndex={candidate.id === selected?.id ? 0 : -1} data-conformer-id={candidate.id} ref={element => { if (element) choiceRefs.current.set(candidate.id, element); else choiceRefs.current.delete(candidate.id); }} onClick={() => chooseConformer(candidate.id)} onKeyDown={event => walkConformers(event, index)} className={`block w-full min-w-0 rounded-md px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${candidate.id === selected?.id ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}>
								<span className="block tabular-nums">ΔE {candidate.relativeEnergy.toFixed(2)}</span>
								{label && <span title={expandedSummary} className="block break-words text-xs text-muted-foreground">{label}</span>}
							</button>;
						})}
					</div>
				</aside>}
				<div key="molecular-viewport" data-testid="molecular-viewport" className="relative h-[min(52vh,420px)] min-h-[260px] min-w-0 flex-none overflow-hidden sm:h-full sm:min-h-0 sm:flex-1" aria-busy={!rendered && !error}>
					<iframe key={attempt} ref={iframeRef} srcDoc={frame} onLoad={() => command({ type: "hello" })} title="Molecular model: drag to rotate and scroll to zoom" sandbox="allow-scripts" className="h-full w-full border-0" />
					{!rendered && !error && <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center text-sm text-muted-foreground">{result ? "Loading 3D viewer…" : searchRequested ? "Searching conformers…" : "Preparing 3D structure…"}</div>}
				</div>
			</div>
			{error && <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => { modelIdRef.current = null; setError(null); setFrameReady(false); setAttempt(value => value + 1); }}>Try again</Button></div>}
			<div className="flex flex-wrap gap-2" aria-label="Rotate and zoom model">
				<Button type="button" variant="outline" size="sm" disabled={!rendered} onClick={() => command({ type: "rotate", axis: "y", angle: -30 })}>Rotate left</Button>
				<Button type="button" variant="outline" size="sm" disabled={!rendered} onClick={() => command({ type: "rotate", axis: "y", angle: 30 })}>Rotate right</Button>
				<Button type="button" variant="outline" size="sm" disabled={!rendered} onClick={() => command({ type: "rotate", axis: "x", angle: 30 })}>Tilt</Button>
				<Button type="button" variant="outline" size="sm" disabled={!rendered} onClick={() => command({ type: "zoom", factor: 1.2 })}>Zoom in</Button>
				<Button type="button" variant="outline" size="sm" disabled={!rendered} onClick={() => command({ type: "zoom", factor: 0.8 })}>Zoom out</Button>
				<Button type="button" variant="ghost" size="sm" disabled={!rendered} onClick={() => command({ type: "reset" })}>Fit model</Button>
			</div>
			{result?.search && <div className="space-y-1 text-xs text-muted-foreground">
				<p data-testid="conformer-search-summary">{result.search.embedded}/{result.search.requested} samples embedded · {result.search.converged} converged · {result.search.unique} distinct · {result.search.returned} shown</p>
				<p>Estimated relative potential energy from a sampled search. These are not free energies or conformer populations; lower structures may remain undiscovered.</p>
			</div>}
			{result && !selected && <p className="text-sm text-muted-foreground" role="status">{result.generated ? "Generated conformer · one possible molecular geometry." : "Imported molecular coordinates · energy not evaluated."}</p>}
			{result?.warning && <p className="text-sm text-muted-foreground" role="status">{result.warning}</p>}
			{result && !result.generated && <Button type="button" variant="outline" size="sm" onClick={() => setSearchedSource(sourceKey)}>Search conformers</Button>}
			{searchRequested && source.sdf && <Button type="button" variant="ghost" size="sm" onClick={() => setSearchedSource(null)}>Show imported coordinates</Button>}
		</section>
	);
}
