const PUBCHEM_NAME_SEARCH_URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/property/Title,MolecularFormula,SMILES/JSON?name_type=complete";
const MAX_QUERY_LENGTH = 300;
const MAX_REQUEST_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 500_000;
const MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 10_000;

export interface ChemicalNameSearchResult {
	cid: number;
	title: string;
	formula: string;
	smiles: string;
}

export class ChemicalNameSearchError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "ChemicalNameSearchError";
	}
}

interface SearchOptions {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function queryName(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new ChemicalNameSearchError("Enter a chemical name to search.", 400);
	}
	const query = value.trim();
	if (query.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(query)) {
		throw new ChemicalNameSearchError(`Use a chemical name with at most ${MAX_QUERY_LENGTH} characters and no control characters.`, 400);
	}
	return query;
}

async function boundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number, oversized: ChemicalNameSearchError): Promise<string> {
	const reader = body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw oversized;
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		reader.releaseLock();
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readableString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

const unreadableResponse = () => new ChemicalNameSearchError("PubChem returned an unreadable structure. Try your search again.", 502);
const noMatch = () => new ChemicalNameSearchError("No compound was found for that name. Try a more specific chemical name.", 404);

function searchResults(value: unknown): ChemicalNameSearchResult[] {
	const rows = record(record(value)?.PropertyTable)?.Properties;
	if (!Array.isArray(rows)) throw unreadableResponse();
	if (rows.length === 0) throw noMatch();
	const results: ChemicalNameSearchResult[] = [];
	const seen = new Set<number>();
	for (const row of rows) {
		const compound = record(row);
		if (!compound || typeof compound.CID !== "number" || !Number.isSafeInteger(compound.CID) || compound.CID < 1
			|| !readableString(compound.Title, 2_000) || !readableString(compound.MolecularFormula, 500)
			|| !readableString(compound.SMILES, 16_000) || /\s/.test(compound.SMILES)) {
			throw unreadableResponse();
		}
		if (seen.has(compound.CID)) continue;
		seen.add(compound.CID);
		results.push({ cid: compound.CID, title: compound.Title.trim(), formula: compound.MolecularFormula.trim(), smiles: compound.SMILES });
		if (results.length === MAX_RESULTS) break;
	}
	return results;
}

/** Exact PubChem synonym lookup. A returned name can still be ambiguous to a
 * learner, so the editor previews these results before an explicit insertion. */
export async function searchChemicalNames(value: unknown, options: SearchOptions = {}): Promise<ChemicalNameSearchResult[]> {
	const query = queryName(value);
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? SEARCH_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
	try {
		const response = await (options.fetch ?? fetch)(PUBCHEM_NAME_SEARCH_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({ name: query }).toString(),
			signal,
			cache: "no-store",
		});
		if (response.status === 404) throw noMatch();
		if (response.status === 503 || response.status === 429) {
			throw new ChemicalNameSearchError("PubChem is busy. Try your search again shortly.", 503);
		}
		if (!response.ok) throw new ChemicalNameSearchError("PubChem could not complete this search. Try again shortly.", 502);
		const text = await boundedText(response.body, MAX_RESPONSE_BYTES, unreadableResponse());
		let payload: unknown;
		try { payload = JSON.parse(text); }
		catch { throw unreadableResponse(); }
		return searchResults(payload);
	} catch (error) {
		if (timeout.signal.aborted) throw new ChemicalNameSearchError("Chemical name search took too long. Try again.", 503);
		if (error instanceof ChemicalNameSearchError) throw error;
		throw new ChemicalNameSearchError("Chemical name search is unavailable. Check your internet connection and try again.", 503);
	} finally {
		clearTimeout(timer);
	}
}

export async function chemistryNameSearchResponse(request: Request): Promise<Response> {
	try {
		const text = await boundedText(request.body, MAX_REQUEST_BYTES, new ChemicalNameSearchError("The chemical search request is too large.", 400));
		let payload: unknown;
		try { payload = JSON.parse(text); }
		catch { throw new ChemicalNameSearchError("The chemical search request must contain valid JSON.", 400); }
		return Response.json({ results: await searchChemicalNames(record(payload)?.query, { signal: request.signal }) });
	} catch (error) {
		const failure = error instanceof ChemicalNameSearchError ? error : new ChemicalNameSearchError("Chemical name search is unavailable. Try again shortly.", 503);
		return Response.json({ error: failure.message }, { status: failure.status });
	}
}
