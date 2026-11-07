/** Portable chemical source. Molfile owns structure/layout when both encodings
 * are present; SMILES is then a derived interchange representation. */
export interface MoleculeSource {
	version?: 1;
	smiles?: string;
	molfile?: string;
	label?: string;
	caption?: string;
	sdf?: string;
	/** Full editable drawing, including curved electron-flow arrows. The
	 * molecular encodings still establish chemical identity. */
	ket?: string;
	/** Complete ordered synthesis, including the first step mirrored above. */
	steps?: MoleculeStepSource[];
}

export type MoleculeStepSource = Omit<MoleculeSource, "steps"> & { id: string; name: string };

/** An editable answer snapshot; SVG and generated conformers are not answers. */
export interface MoleculeDocument {
	version: 1;
	molfile: string;
	smiles: string;
	ket?: string;
	label?: string;
	/** Every step is a complete independently editable molecular snapshot. */
	steps?: MoleculeStepDocument[];
}

export type MoleculeStepDocument = Omit<MoleculeDocument, "steps"> & { id: string; name: string };

/** A conservative geometric classification for an isolated, saturated,
 * six-carbon ring. Other rings are omitted, not assigned a guessed shape. */
export interface RingConformation {
	/** Zero-based indices in each returned SDF; ring order is stable. */
	atomIndices: number[];
	shape: "chair" | "non-chair" | "near-planar";
	/** Cremer–Pople polar angle in degrees and amplitude in angstroms. */
	theta: number;
	amplitude: number;
	torsions: number[];
	/** Relative to the fixed atom order; these are not absolute up/down labels. */
	chairBasin?: "positive" | "negative";
	/** Complete small-group summary for one validated cyclohexane chair.
	 * Omitted if any group or orientation is unsupported. These orientations
	 * can change on a chair flip; they do not describe cis/trans configuration. */
	substituents?: {
		/** Zero-based SDF indices, not course or IUPAC position numbers. */
		atomIndex: number;
		substituentAtomIndex: number;
		label: string;
		orientation: "axial" | "equatorial";
	}[];
}

export interface MoleculeConformer {
	id: string;
	sdf: string;
	/** Force-field potential energy in kcal/mol, not solution free energy. */
	energy: number;
	relativeEnergy: number;
	rings: RingConformation[];
}

export interface ConformerSearchSummary {
	method: "MMFF94" | "UFF";
	requested: number;
	embedded: number;
	converged: number;
	stereoRejected: number;
	unique: number;
	returned: number;
	rmsdThreshold: number;
	seed: number;
	stereochemistry: "specified" | "assigned-for-search";
	/** The single stereoisomer whose conformers were compared. */
	isomericSmiles: string;
	energyUnit: "kcal/mol";
	exhaustive: false;
}

export interface ConformerResult {
	/** Lowest sampled energy, or validated imported coordinates. */
	sdf: string;
	generated: boolean;
	warning?: string;
	/** Imported coordinates have no inferred energy or search metadata. */
	conformers?: MoleculeConformer[];
	search?: ConformerSearchSummary;
}

export const MAX_MOLECULE_ATOMS = 512;
export const MAX_CHEMISTRY_REQUEST_BYTES = 1_000_000;
export const MAX_SYNTHESIS_STEPS = 12;
const LIMITS = { smiles: 16_000, molfile: 200_000, sdf: 200_000, ket: 500_000, label: 240, caption: 2_000 };

export class ChemistryInputError extends Error {}

/** Match both Markdown fence styles and longer fences. This is deliberately
 * conservative: a chemistry option must never nest buttons inside a button. */
export function hasMoleculeBlock(markdown: string): boolean {
	return /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[ \t]*(?:molecule|smiles)\b/i.test(markdown);
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ChemistryInputError("A molecule must be an object containing SMILES or a Molfile.");
	}
	return value as Record<string, unknown>;
}

function optionalText(value: Record<string, unknown>, key: keyof typeof LIMITS): string | undefined {
	const text = value[key];
	if (text === undefined) return undefined;
	if (typeof text !== "string" || text.length > LIMITS[key] || text.includes("\0")) {
		throw new ChemistryInputError(`Invalid or oversized molecule ${key}.`);
	}
	return text.trim() ? text : undefined;
}

function parseSingleMoleculeSource(input: Record<string, unknown>): Omit<MoleculeSource, "steps"> {
	if (input.version !== undefined && input.version !== 1) throw new ChemistryInputError("Unsupported molecule version.");
	const smiles = optionalText(input, "smiles")?.trim();
	const molfile = optionalText(input, "molfile");
	const sdf = optionalText(input, "sdf");
	if (sdf?.split("$$$$").slice(1).some(part => part.trim())) throw new ChemistryInputError("Provide one SDF molecule at a time.");
	const label = optionalText(input, "label");
	const caption = optionalText(input, "caption");
	const ket = optionalText(input, "ket");
	if (ket) {
		try { record(JSON.parse(ket)); }
		catch { throw new ChemistryInputError("The saved editor document is not valid JSON."); }
	}
	if (!smiles && !molfile && !sdf) throw new ChemistryInputError("Add a SMILES string or Molfile to display a molecule.");
	return { version: 1, ...(smiles && { smiles }), ...(molfile && { molfile }), ...(sdf && { sdf }), ...(label && { label }), ...(caption && { caption }), ...(ket && { ket }) };
}

function stepIdentity(input: Record<string, unknown>): { id: string; name: string } {
	if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id)) {
		throw new ChemistryInputError("Each synthesis step requires a unique ID of at most 100 letters, numbers, hyphens, or underscores.");
	}
	if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120 || /[\u0000-\u001f\u007f]/.test(input.name)) {
		throw new ChemistryInputError("Name each synthesis step using at most 120 characters.");
	}
	return { id: input.id, name: input.name.trim() };
}

function checkMoleculeSize(source: MoleculeSource): void {
	if (new TextEncoder().encode(JSON.stringify(source)).byteLength > MAX_CHEMISTRY_REQUEST_BYTES) {
		throw new ChemistryInputError("This molecular drawing or synthesis is too large. Keep all steps together under 1 MB.");
	}
}

export function parseMoleculeSource(value: unknown): MoleculeSource {
	const input = record(value);
	const source: MoleculeSource = parseSingleMoleculeSource(input);
	if (input.steps !== undefined) {
		if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_SYNTHESIS_STEPS) {
			throw new ChemistryInputError(`A synthesis requires between 1 and ${MAX_SYNTHESIS_STEPS} complete steps.`);
		}
		const ids = new Set<string>();
		source.steps = input.steps.map(value => {
			const step = record(value);
			if (step.steps !== undefined) throw new ChemistryInputError("Synthesis steps cannot contain nested steps.");
			const identity = stepIdentity(step);
			if (ids.has(identity.id)) throw new ChemistryInputError("Each synthesis step must have a unique ID.");
			ids.add(identity.id);
			return { ...parseSingleMoleculeSource(step), ...identity };
		});
		const first = source.steps[0]!;
		if ((["smiles", "molfile", "ket", "sdf"] as const).some(key => source[key] !== first[key])) {
			throw new ChemistryInputError("The synthesis must mirror its first step in the root molecular structure.");
		}
	}
	checkMoleculeSize(source);
	return source;
}

/** Called only for a complete fence; partial streamed JSON is not chemistry. */
export function parseMoleculeBlock(source: string, language = "molecule"): MoleculeSource {
	if (new TextEncoder().encode(source).byteLength > MAX_CHEMISTRY_REQUEST_BYTES) throw new ChemistryInputError("This molecule block is too large.");
	if (language === "smiles") return parseMoleculeSource({ smiles: source.trim() });
	try {
		return parseMoleculeSource(JSON.parse(source));
	} catch (error) {
		if (error instanceof ChemistryInputError) throw error;
		throw new ChemistryInputError("Use valid JSON in a molecule block, or a smiles block for plain SMILES.");
	}
}

function singleMoleculeDocument(input: Record<string, unknown>, source: MoleculeSource): Omit<MoleculeDocument, "steps"> {
	if (input.version !== 1 || !source.molfile || !source.smiles) {
		throw new ChemistryInputError("A molecular answer requires version 1, Molfile, and SMILES.");
	}
	const ket = source.ket;
	return { version: 1, molfile: source.molfile, smiles: source.smiles, ...(source.label && { label: source.label }), ...(ket && { ket }) };
}

export function parseMoleculeDocument(value: unknown): MoleculeDocument {
	const input = record(value);
	const source = parseMoleculeSource(input);
	const document: MoleculeDocument = singleMoleculeDocument(input, source);
	if (source.steps) {
		const steps = input.steps as unknown[];
		document.steps = source.steps.map((step, index) => ({ ...singleMoleculeDocument(record(steps[index]), step), id: step.id, name: step.name }));
	}
	return document;
}

export function moleculeInput(source: MoleculeSource): string {
	const parsed = parseMoleculeSource(source);
	return parsed.molfile ?? parsed.smiles ?? parsed.sdf!;
}

export function moleculeMarkdown(source: MoleculeSource): string {
	return "```molecule\n" + JSON.stringify(parseMoleculeSource(source)) + "\n```";
}
