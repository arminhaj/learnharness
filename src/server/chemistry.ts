import initRDKit, { type MainModule } from "@rdkit/rdkit";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
	ChemistryInputError, MAX_CHEMISTRY_REQUEST_BYTES, MAX_MOLECULE_ATOMS,
	moleculeInput, parseMoleculeDocument, parseMoleculeSource,
	type MoleculeDocument, type MoleculeSource,
} from "../core/chemistry.ts";

let rdkitPromise: Promise<MainModule> | undefined;
function rdkit(): Promise<MainModule> {
	return rdkitPromise ??= initRDKit().catch((error: unknown) => { rdkitPromise = undefined; throw error; });
}

/** Authoritative validation is performed again on the server before storage.
 * A client-supplied SMILES never overrides a submitted Molfile. */
export async function normalizeMolecule(source: MoleculeSource): Promise<MoleculeDocument> {
	const parsed = parseMoleculeSource(source);
	const engine = await rdkit();
	let molecule;
	let canonical;
	try {
		molecule = engine.get_mol(moleculeInput(parsed));
		if (!molecule || molecule.get_num_atoms() === 0) throw new ChemistryInputError("This structure could not be read. Check its bonds, charges, and valences.");
		if (molecule.get_num_atoms() > MAX_MOLECULE_ATOMS) throw new ChemistryInputError(`Use a molecule with at most ${MAX_MOLECULE_ATOMS} atoms.`);
		// Preserve the learner's explicit-H drawing, but use the conventional
		// implicit-H encoding for interchange. Isotopic H remains explicit.
		canonical = engine.get_mol_copy(molecule);
		if (!canonical) throw new ChemistryInputError("This structure could not be copied.");
		canonical.remove_hs_in_place();
		return {
			version: 1,
			molfile: molecule.get_molblock(),
			smiles: canonical.get_smiles(),
			...(parsed.label && { label: parsed.label }),
		};
	} catch (error) {
		if (error instanceof ChemistryInputError) throw error;
		throw new ChemistryInputError("This structure could not be read. Check its bonds, charges, and valences.");
	} finally {
		canonical?.delete();
		molecule?.delete();
	}
}

/** Keeps the editable document while independently deriving the chemical
 * interchange source. KET remains inert JSON, never executable content. */
export async function normalizeMoleculeDocument(value: unknown): Promise<MoleculeDocument> {
	const document = parseMoleculeDocument(value);
	const normalized = await normalizeMolecule(document);
	return { ...normalized, ...(document.ket && { ket: document.ket }) };
}

export class ChemistryUnavailableError extends Error {}
export interface ConformerResult { sdf: string; generated: boolean; warning?: string }

/** Imported coordinates are checked against the same structure as the 2D
 * view; an old SDF must never survive an edit to the answer's bonds. */
async function importedConformer(source: MoleculeSource, normalized: MoleculeDocument): Promise<ConformerResult | null> {
	if (!source.sdf) return null;
	const imported = await normalizeMolecule({ sdf: source.sdf });
	if (imported.smiles !== normalized.smiles) throw new ChemistryInputError("These 3D coordinates belong to a different structure. Regenerate the 3D model after editing.");
	const engine = await rdkit();
	const molecule = engine.get_mol(source.sdf);
	try {
		if (!molecule) throw new ChemistryInputError("The imported 3D structure could not be read.");
		const json = JSON.parse(molecule.get_json()) as { molecules?: { conformers?: { dim?: number; coords?: number[][] }[] }[] };
		const conformer = json.molecules?.[0]?.conformers?.[0];
		if (conformer?.dim !== 3) return null;
		if (conformer.coords?.length !== molecule.get_num_atoms() || !conformer.coords.every(point => point.length === 3 && point.every(Number.isFinite))) {
			throw new ChemistryInputError("The imported 3D coordinates are invalid.");
		}
		return { sdf: molecule.get_molblock() + "\n$$$$\n", generated: false };
	} finally {
		molecule?.delete();
	}
}

export function chemistryPython(): string {
	const local = path.join(process.cwd(), ".venv-chemistry", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	if (process.env.LH_CHEMISTRY_PYTHON) return process.env.LH_CHEMISTRY_PYTHON;
	if (existsSync(local)) return local;
	throw new ChemistryUnavailableError("3D generation is not set up on this computer. Run python3 scripts/setup-chemistry.py, or set LH_CHEMISTRY_PYTHON to a Python with RDKit installed.");
}

let conformerJobs = 0;
export async function generateConformer(source: MoleculeSource): Promise<ConformerResult> {
	const parsed = parseMoleculeSource(source);
	const normalized = await normalizeMolecule(parsed);
	const imported = await importedConformer(parsed, normalized);
	if (imported) return imported;
	const python = chemistryPython();
	if (conformerJobs >= 2) throw new ChemistryUnavailableError("Two 3D models are already being prepared. Please try again shortly.");
	conformerJobs++;
	try {
		return await new Promise<ConformerResult>((resolve, reject) => {
			// No shell: source arrives on stdin and can never become a command.
			const child = spawn(python, [path.join(process.cwd(), "scripts", "chemistry-conformer.py")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
			let output = "";
			let errors = "";
			let settled = false;
			const finish = (error?: Error, result?: ConformerResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error); else resolve(result!);
			};
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				finish(new ChemistryUnavailableError("3D generation took too long. Try a smaller structure."));
			}, 25_000);
			child.on("error", () => finish(new ChemistryUnavailableError("The local 3D helper could not start. Run python3 scripts/setup-chemistry.py or check LH_CHEMISTRY_PYTHON.")));
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.length > 1_000_000) {
					child.kill("SIGKILL");
					finish(new ChemistryUnavailableError("The generated model exceeded the supported size."));
				}
			});
			child.stderr.on("data", (chunk: Buffer) => { if (errors.length < 4_000) errors += chunk.toString(); });
			child.stdin.on("error", () => { /* Process exit below owns the error. */ });
			child.on("close", (code) => {
				if (settled) return;
				try {
					const result = JSON.parse(output) as { sdf?: unknown; generated?: unknown; warning?: unknown; error?: unknown };
					if (code !== 0 || typeof result.sdf !== "string" || result.generated !== true) {
						const message = typeof result.error === "string" ? result.error : "A 3D conformer could not be generated for this structure.";
						finish(code === 2 ? new ChemistryUnavailableError(message) : new ChemistryInputError(message));
						return;
					}
					finish(undefined, { sdf: result.sdf, generated: true, ...(typeof result.warning === "string" && { warning: result.warning }) });
				} catch {
					finish(new ChemistryUnavailableError(errors.includes("No module named 'rdkit'") ? "RDKit is missing from the local 3D helper. Run python3 scripts/setup-chemistry.py." : "The local 3D helper failed. Check its Python installation."));
				}
			});
			child.stdin.end(JSON.stringify({ molfile: normalized.molfile }));
		});
	} finally {
		conformerJobs--;
	}
}

async function requestSource(request: Request): Promise<MoleculeSource> {
	const reader = request.body?.getReader();
	if (!reader) throw new ChemistryInputError("A molecule is required.");
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_CHEMISTRY_REQUEST_BYTES) {
			await reader.cancel();
			throw new ChemistryInputError("The molecule request is too large.");
		}
		chunks.push(value);
	}
	try {
		return parseMoleculeSource(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch (error) {
		if (error instanceof ChemistryInputError) throw error;
		throw new ChemistryInputError("The molecule request must contain valid JSON.");
	}
}

function failure(error: unknown): Response {
	const status = error instanceof ChemistryInputError ? 400 : error instanceof ChemistryUnavailableError ? 503 : 500;
	return Response.json({ error: error instanceof Error ? error.message : "The chemistry operation failed." }, { status });
}

export async function chemistryNormalizeResponse(request: Request): Promise<Response> {
	try { return Response.json(await normalizeMolecule(await requestSource(request))); }
	catch (error) { return failure(error); }
}

export async function chemistryConformerResponse(request: Request): Promise<Response> {
	try { return Response.json(await generateConformer(await requestSource(request))); }
	catch (error) { return failure(error); }
}
