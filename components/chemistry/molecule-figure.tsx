"use client";

/* eslint-disable @next/next/no-img-element -- locally generated SVG data URLs need no image optimizer. */

import { lazy, Suspense, useEffect, useState } from "react";
import { moleculeInput, parseMoleculeBlock, type MoleculeSource } from "@/src/core";
import { useAppearance } from "@/components/settings/appearance";
import { copyText } from "@/components/copy-text";
import { drawMolecule } from "./rdkit-client";
import { ChemistryDialog } from "./chemistry-dialog";
import { useChemistryAnswer } from "./answer-context";

const StructureEditor = lazy(() => import("./structure-editor"));
const Molecule3D = lazy(() => import("./molecule-3d"));
const actionClass = "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function MoleculeFigure({ source, actions = true }: { source: MoleculeSource; actions?: boolean }) {
	const { resolvedMode } = useAppearance();
	const [svg, setSvg] = useState<string>();
	const [error, setError] = useState<string>();
	const [attempt, setAttempt] = useState(0);
	const [mode, setMode] = useState<"2d" | "3d" | "edit" | null>(null);
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const [zoom, setZoom] = useState(2);
	const [edited, setEdited] = useState<MoleculeSource>();
	const onUse = useChemistryAnswer();
	const input = JSON.stringify(source);
	useEffect(() => {
		let current = true;
		setSvg(undefined); setError(undefined);
		void drawMolecule(JSON.parse(input) as MoleculeSource, resolvedMode === "dark").then(
			(value) => { if (current) setSvg(value); },
			(reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "Could not draw this structure."); },
		);
		return () => { current = false; };
	}, [input, resolvedMode, attempt]);
	useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
	const image = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : undefined;
	return <figure className="my-3 min-w-0" data-testid="molecule-figure">
		{source.label && <figcaption className="mb-1 text-center text-sm font-medium">{source.label}</figcaption>}
		<div className="flex min-h-24 items-center justify-center py-2" aria-busy={!svg && !error}>
			{image ? <img src={image} alt={source.label || "Molecular structure"} className="block h-auto max-h-80 max-w-full" />
				: error ? <div role="alert" className="text-sm text-muted-foreground">{error} <button type="button" className="underline" onClick={() => setAttempt(a => a + 1)}>Retry</button></div>
					: <span className="text-sm text-muted-foreground">Drawing molecule…</span>}
		</div>
		{source.caption && <p className="text-center text-sm text-muted-foreground">{source.caption}</p>}
		{actions && <div data-chemistry-interactive="" className="flex flex-wrap justify-center gap-1" onKeyDown={event => event.stopPropagation()}>
			<button type="button" className={actionClass} disabled={!svg} onClick={() => setMode("2d")}>Expand</button>
			<button type="button" className={actionClass} disabled={!svg} onClick={() => setMode("3d")}>View 3D</button>
			<button type="button" className={actionClass} disabled={!svg} onClick={() => {
				void copyText(moleculeInput(source)).then(ok => { setCopied(ok); setCopyError(!ok); });
			}}>{copied ? "Copied" : "Copy structure"}</button>
			<button type="button" className={actionClass} disabled={!svg} onClick={() => { setEdited(undefined); if (onUse) onUse({ ...source }); else setMode("edit"); }}>{onUse ? "Use in answer" : "Edit a copy"}</button>
		</div>}
		{copyError && <p role="status" className="mt-1 text-center text-xs text-muted-foreground">Could not copy the structure. You can open it in the editor to export it.</p>}
		{mode && <ChemistryDialog title={mode === "edit" ? "Edit a copy" : source.label || "Molecular structure"} onClose={() => setMode(null)}>
			<Suspense fallback={<p className="p-6 text-muted-foreground">Loading chemistry tools…</p>}>
				{mode === "3d" ? <Molecule3D source={source} /> : mode === "edit" ?
					<>{edited ? <><MoleculeFigure source={edited} /><button type="button" className={actionClass} onClick={() => setMode(null)}>Done</button></> : <StructureEditor initial={source} onSave={setEdited} onCancel={() => setMode(null)} />}</>
					: <><div className="flex justify-center gap-2"><button type="button" className={actionClass} onClick={() => setZoom(z => Math.max(.5, z - .5))}>Zoom out</button><button type="button" className={actionClass} onClick={() => setZoom(z => Math.min(5, z + .5))}>Zoom in</button><button type="button" className={actionClass} onClick={() => setMode("3d")}>View 3D</button></div><div className="flex min-h-72 items-center justify-center overflow-auto p-8">{image && <img src={image} alt={source.label || "Molecular structure"} style={{ zoom }} />}</div></>}
			</Suspense>
		</ChemistryDialog>}
	</figure>;
}

export function MoleculeBlock({ source, language, incomplete }: { source: string; language: string; incomplete: boolean }) {
	if (incomplete) return <div data-testid="molecule-pending" aria-busy="true" className="my-4 text-sm text-muted-foreground">Receiving structure…</div>;
	try { return <MoleculeFigure source={parseMoleculeBlock(source, language)} />; }
	catch { return <div role="alert" className="my-3 text-sm text-muted-foreground">This molecular structure could not be read.</div>; }
}
