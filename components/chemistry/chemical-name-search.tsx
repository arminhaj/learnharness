"use client";

/* eslint-disable @next/next/no-img-element -- structure previews are locally generated SVG data URLs. */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { drawMolecule } from "./rdkit-client";

export interface ChemicalSearchResult {
	cid: number;
	title: string;
	formula: string;
	smiles: string;
}

function isSearchResult(value: unknown): value is ChemicalSearchResult {
	if (!value || typeof value !== "object") return false;
	const result = value as Record<string, unknown>;
	return Number.isSafeInteger(result.cid) && Number(result.cid) > 0
		&& ["title", "formula", "smiles"].every(key => typeof result[key] === "string" && (result[key] as string).trim().length > 0);
}

function StructurePreview({ result }: { result: ChemicalSearchResult }) {
	const [svg, setSvg] = useState<string>();
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let current = true;
		setSvg(undefined);
		setFailed(false);
		void drawMolecule({ smiles: result.smiles }).then(
			value => { if (current) setSvg(value); },
			() => { if (current) setFailed(true); },
		);
		return () => { current = false; };
	}, [result.smiles]);
	return <div className="flex h-20 w-32 shrink-0 items-center justify-center rounded border bg-white p-1 text-xs text-gray-600" aria-busy={!svg && !failed}>
		{svg ? <img className="h-full w-full object-contain" alt={`${result.title} structure`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} />
			: failed ? <span>Preview unavailable</span> : <span>Drawing structure…</span>}
	</div>;
}

export function ChemicalNameSearch({ disabled = false, onInsert }: {
	disabled?: boolean;
	onInsert: (result: ChemicalSearchResult) => Promise<void>;
}) {
	const inputId = useId();
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<ChemicalSearchResult[]>([]);
	const [searching, setSearching] = useState(false);
	const [inserting, setInserting] = useState<number | null>(null);
	const [error, setError] = useState<string>();
	const [status, setStatus] = useState<string>();
	const request = useRef(0);
	const controller = useRef<AbortController | null>(null);
	const mounted = useRef(true);
	const insertionPending = useRef(false);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			request.current++;
			controller.current?.abort();
		};
	}, []);

	const updateQuery = (value: string) => {
		request.current++;
		controller.current?.abort();
		setQuery(value);
		setResults([]);
		setSearching(false);
		setError(undefined);
		setStatus(undefined);
	};

	const search = async (event: FormEvent) => {
		event.preventDefault();
		event.stopPropagation();
		if (disabled || insertionPending.current || searching || !query.trim()) return;
		const currentRequest = ++request.current;
		controller.current?.abort();
		const abort = new AbortController();
		controller.current = abort;
		setSearching(true);
		setResults([]);
		setError(undefined);
		setStatus(undefined);
		try {
			const response = await fetch("/api/chemistry/search", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: query.trim() }), signal: abort.signal,
			});
			if (!mounted.current || currentRequest !== request.current) return;
			if (response.status === 404) {
				setStatus("No matching chemicals found. Try a more specific name.");
				return;
			}
			const value: unknown = await response.json();
			if (!mounted.current || currentRequest !== request.current) return;
			if (!value || typeof value !== "object") throw new Error("Chemical search returned an unreadable response. Try again.");
			const body = value as { results?: unknown; error?: unknown };
			if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Chemical search is unavailable. Try again.");
			if (!Array.isArray(body.results) || !body.results.every(isSearchResult)) throw new Error("Chemical search returned an unreadable response. Try again.");
			setResults(body.results);
			setStatus(body.results.length ? `${body.results.length} ${body.results.length === 1 ? "match" : "matches"} found. Check the structure before inserting.` : "No matching chemicals found. Try a more specific name.");
		} catch (reason) {
			if (mounted.current && currentRequest === request.current && !abort.signal.aborted) {
				setError(reason instanceof Error ? reason.message : "Chemical search is unavailable. Try again.");
			}
		} finally {
			if (mounted.current && currentRequest === request.current) setSearching(false);
		}
	};

	const insert = async (result: ChemicalSearchResult) => {
		if (disabled || insertionPending.current) return;
		insertionPending.current = true;
		setInserting(result.cid);
		setError(undefined);
		setStatus(undefined);
		try {
			await onInsert(result);
			if (mounted.current) {
				setResults([]);
				setStatus(`Inserted ${result.title}.`);
			}
		} catch (reason) {
			if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not insert this structure. Try again.");
		} finally {
			insertionPending.current = false;
			if (mounted.current) setInserting(null);
		}
	};

	return <section aria-label="Chemical name search" className="space-y-2" onKeyDown={event => event.stopPropagation()}>
		<form role="search" aria-label="Search chemicals by name" className="space-y-2" onSubmit={event => void search(event)}>
			<label htmlFor={inputId} className="block text-sm font-medium">Search by chemical name</label>
			<div className="flex gap-2">
				<Input id={inputId} type="text" value={query} placeholder="e.g. sulfuric acid" maxLength={300} autoComplete="off" disabled={disabled || inserting !== null} onChange={event => updateQuery(event.target.value)} />
				<Button type="submit" variant="outline" disabled={disabled || searching || inserting !== null || !query.trim()}>{searching ? "Searching…" : "Search"}</Button>
			</div>
		</form>
		{searching && <p role="status" className="text-xs text-muted-foreground">Searching PubChem…</p>}
		{status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}
		{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
		{results.length > 0 && <ul className="max-h-60 space-y-2 overflow-auto rounded-md border p-2" aria-label="Chemical search results">
			{results.map(result => <li key={result.cid} className="flex flex-wrap items-center gap-3 rounded p-1">
				<StructurePreview result={result} />
				<div className="min-w-0 flex-1 space-y-1">
					<p className="break-words text-sm font-medium">{result.title}</p>
					<p className="text-xs text-muted-foreground">{result.formula}</p>
					<a className="text-xs text-muted-foreground underline hover:text-foreground" href={`https://pubchem.ncbi.nlm.nih.gov/compound/${result.cid}`} target="_blank" rel="noreferrer">PubChem · CID {result.cid}</a>
				</div>
				<Button type="button" size="sm" disabled={disabled || inserting !== null} aria-label={`Insert ${result.title}`} onClick={() => void insert(result)}>{inserting === result.cid ? "Inserting…" : "Insert"}</Button>
			</li>)}
		</ul>}
	</section>;
}
