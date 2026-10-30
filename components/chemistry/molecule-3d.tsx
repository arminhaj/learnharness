"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { MoleculeSource } from "@/src/core";
import { viewerFrameHtml } from "./viewer-frame";

type Conformer = { sdf: string; generated: boolean; warning?: string };

export default function Molecule3D({ source }: { source: MoleculeSource }) {
	const id = useId();
	const channel = `lh-chemistry-3d-${id}`;
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [attempt, setAttempt] = useState(0);
	const [frameReady, setFrameReady] = useState(false);
	const [rendered, setRendered] = useState(false);
	const [conformer, setConformer] = useState<Conformer | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [style, setStyle] = useState<"balls" | "sticks">("balls");
	const styleRef = useRef(style);
	styleRef.current = style;
	const sourceKey = JSON.stringify(source);
	const frame = useMemo(() => typeof window === "undefined" ? "" : viewerFrameHtml(`${window.location.origin}/chemistry/3Dmol-min.js`, channel), [channel]);

	useEffect(() => {
		const controller = new AbortController();
		setError(null);
		setConformer(null);
		setRendered(false);
		iframeRef.current?.contentWindow?.postMessage({ channel, type: "clear" }, "*");
		// The endpoint checks imported coordinates against the molecular graph,
		// and generates geometry if an imported SDF still contains a flat sketch.
		void fetch("/api/chemistry/conformer", { method: "POST", headers: { "Content-Type": "application/json" }, body: sourceKey, signal: controller.signal })
			.then(async (response) => {
				const result = await response.json();
				if (!response.ok) throw new Error(result.error || "Could not generate a 3D model.");
				if (!controller.signal.aborted) setConformer(result);
			})
			.catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not generate a 3D model."); });
		return () => controller.abort();
	}, [sourceKey, attempt, channel]);

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (event.source !== iframeRef.current?.contentWindow || event.data?.channel !== channel) return;
			if (event.data.type === "ready") setFrameReady(true);
			if (event.data.type === "rendered") setRendered(true);
			if (event.data.type === "error") setError(String(event.data.error));
		};
		window.addEventListener("message", receive);
		return () => window.removeEventListener("message", receive);
	}, [channel]);

	useEffect(() => {
		if (frameReady) return;
		const timer = setTimeout(() => setError("The 3D viewer did not initialize. Try opening it again."), 15000);
		return () => clearTimeout(timer);
	}, [frameReady, attempt]);

	useEffect(() => {
		if (!frameReady || !conformer || rendered) return;
		const timer = setTimeout(() => setError("The molecular model could not be displayed. WebGL may be unavailable."), 15000);
		return () => clearTimeout(timer);
	}, [frameReady, conformer, rendered]);

	useEffect(() => {
		if (frameReady && conformer) iframeRef.current?.contentWindow?.postMessage({ channel, type: "model", sdf: conformer.sdf, style: styleRef.current }, "*");
	}, [frameReady, conformer, channel]);

	useEffect(() => {
		const element = iframeRef.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => element.contentWindow?.postMessage({ channel, type: "resize" }, "*"));
		observer.observe(element);
		return () => observer.disconnect();
	}, [channel]);

	const command = (message: Record<string, unknown>) => iframeRef.current?.contentWindow?.postMessage({ channel, ...message }, "*");
	const selectStyle = (next: "balls" | "sticks") => { setStyle(next); command({ type: "style", style: next }); };

	return (
		<section data-testid="molecule-3d" data-chemistry-interactive="" className="space-y-3" aria-label={source.label ? `3D view of ${source.label}` : "3D molecular view"}>
			<div className="flex flex-wrap items-center gap-2" aria-label="Model appearance">
				<Button type="button" size="sm" variant={style === "balls" ? "secondary" : "ghost"} aria-pressed={style === "balls"} onClick={() => selectStyle("balls")}>Ball and stick</Button>
				<Button type="button" size="sm" variant={style === "sticks" ? "secondary" : "ghost"} aria-pressed={style === "sticks"} onClick={() => selectStyle("sticks")}>Sticks</Button>
			</div>
			<div className="relative h-[min(52vh,420px)] min-h-[260px] overflow-hidden rounded-md border bg-background" aria-busy={!rendered && !error}>
				<iframe key={attempt} ref={iframeRef} srcDoc={frame} onLoad={() => command({ type: "hello" })} title="Molecular model: drag to rotate and scroll to zoom" sandbox="allow-scripts" className="h-full w-full border-0" />
				{!rendered && !error && <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{conformer ? "Loading 3D viewer…" : "Generating 3D structure…"}</div>}
			</div>
			{error && <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => { setError(null); setFrameReady(false); setAttempt((value) => value + 1); }}>Try again</Button></div>}
			<div className="flex flex-wrap gap-2" aria-label="Rotate and zoom model">
				<Button type="button" variant="outline" size="sm" disabled={!rendered} onClick={() => command({ type: "rotate", axis: "y", angle: -30 })}>Rotate left</Button>
				<Button type="button" variant="outline" size="sm" disabled={!rendered} onClick={() => command({ type: "rotate", axis: "y", angle: 30 })}>Rotate right</Button>
				<Button type="button" variant="outline" size="sm" disabled={!rendered} onClick={() => command({ type: "rotate", axis: "x", angle: 30 })}>Tilt</Button>
				<Button type="button" variant="outline" size="sm" disabled={!rendered} onClick={() => command({ type: "zoom", factor: 1.2 })}>Zoom in</Button>
				<Button type="button" variant="outline" size="sm" disabled={!rendered} onClick={() => command({ type: "zoom", factor: 0.8 })}>Zoom out</Button>
				<Button type="button" variant="ghost" size="sm" disabled={!rendered} onClick={() => command({ type: "reset" })}>Fit model</Button>
			</div>
			{conformer && <p className="text-sm text-muted-foreground" role="status">{conformer.generated ? "Generated conformer · one possible molecular geometry." : "Imported molecular coordinates."}{conformer.warning ? ` ${conformer.warning}` : ""}</p>}
		</section>
	);
}
