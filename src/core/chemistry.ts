/** Portable chemical source. Molfile owns structure/layout when both encodings
 * are present; SMILES is then a derived interchange representation. */
export interface MoleculeSource {
	version?: 1;
	smiles?: string;
	molfile?: string;
	label?: string;
	caption?: string;
	sdf?: string;
}

/** An editable answer snapshot; SVG and generated conformers are not answers. */
export interface MoleculeDocument {
	version: 1;
	molfile: string;
	smiles: string;
	ket?: string;
	label?: string;
}

export const MAX_MOLECULE_ATOMS = 512;
export const MAX_CHEMISTRY_REQUEST_BYTES = 1_000_000;
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

export function parseMoleculeSource(value: unknown): MoleculeSource {
	const input = record(value);
	if (input.version !== undefined && input.version !== 1) throw new ChemistryInputError("Unsupported molecule version.");
	const smiles = optionalText(input, "smiles")?.trim();
	const molfile = optionalText(input, "molfile");
	const sdf = optionalText(input, "sdf");
	if (sdf?.split("$$$$").slice(1).some(part => part.trim())) throw new ChemistryInputError("Provide one SDF molecule at a time.");
	const label = optionalText(input, "label");
	const caption = optionalText(input, "caption");
	if (!smiles && !molfile && !sdf) throw new ChemistryInputError("Add a SMILES string or Molfile to display a molecule.");
	return { version: 1, ...(smiles && { smiles }), ...(molfile && { molfile }), ...(sdf && { sdf }), ...(label && { label }), ...(caption && { caption }) };
}

/** Called only for a complete fence; partial streamed JSON is not chemistry. */
export function parseMoleculeBlock(source: string, language = "molecule"): MoleculeSource {
	if (source.length > MAX_CHEMISTRY_REQUEST_BYTES) throw new ChemistryInputError("This molecule block is too large.");
	if (language === "smiles") return parseMoleculeSource({ smiles: source.trim() });
	try {
		return parseMoleculeSource(JSON.parse(source));
	} catch (error) {
		if (error instanceof ChemistryInputError) throw error;
		throw new ChemistryInputError("Use valid JSON in a molecule block, or a smiles block for plain SMILES.");
	}
}

export function parseMoleculeDocument(value: unknown): MoleculeDocument {
	const input = record(value);
	const source = parseMoleculeSource(input);
	if (input.version !== 1 || !source.molfile || !source.smiles) {
		throw new ChemistryInputError("A molecular answer requires version 1, Molfile, and SMILES.");
	}
	const ket = optionalText(input, "ket");
	if (ket) {
		try {
			record(JSON.parse(ket));
		} catch {
			throw new ChemistryInputError("The saved editor document is not valid JSON.");
		}
	}
	return { version: 1, molfile: source.molfile, smiles: source.smiles, ...(source.label && { label: source.label }), ...(ket && { ket }) };
}

export function moleculeInput(source: MoleculeSource): string {
	const parsed = parseMoleculeSource(source);
	return parsed.molfile ?? parsed.smiles ?? parsed.sdf!;
}

export function moleculeMarkdown(source: MoleculeSource): string {
	return "```molecule\n" + JSON.stringify(parseMoleculeSource(source)) + "\n```";
}
