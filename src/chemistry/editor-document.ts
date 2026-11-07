import { KetSerializer, MolSerializer, RxnArrow } from "ketcher-core";
import { ChemistryInputError, MAX_MOLECULE_ATOMS } from "../core/chemistry.ts";

/** Derive chemistry from a drawing without treating electron-flow arrows as
 * reactant/product separators. The original KET is retained independently. */
export function moleculeFromEditorDocument(ket: string): string {
	if (typeof ket !== "string" || ket.length > 500_000 || ket.includes("\0")) {
		throw new ChemistryInputError("Invalid or oversized molecule ket.");
	}
	try {
		const document = JSON.parse(ket) as { root?: { nodes?: { type?: string }[] } };
		if (Array.isArray(document?.root?.nodes) && document.root.nodes.some(node => node?.type === "multi-tailed-arrow")) {
			throw new ChemistryInputError("Use curved electron-flow arrows with your structures. Reaction schemes are not supported in this answer editor.");
		}
		const structure = new KetSerializer().deserialize(ket);
		if (structure.atoms.size === 0) throw new ChemistryInputError("Draw a structure before saving it.");
		if (structure.atoms.size > MAX_MOLECULE_ATOMS) throw new ChemistryInputError(`Use a molecule with at most ${MAX_MOLECULE_ATOMS} atoms.`);
		if (structure.rxnPluses.size || structure.multitailArrows.size
			|| [...structure.rxnArrows.values()].some(arrow => !RxnArrow.isElliptical(arrow))) {
			throw new ChemistryInputError("Use curved electron-flow arrows with your structures. Reaction schemes are not supported in this answer editor.");
		}
		for (const arrow of structure.rxnArrows.values()) {
			if (arrow.pos.length !== 2 || arrow.pos.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))
				|| (arrow.height !== undefined && !Number.isFinite(arrow.height))) {
				throw new ChemistryInputError("The saved curved arrow has invalid coordinates.");
			}
		}
		return new MolSerializer().serialize(structure.clone(null, null, true));
	} catch (error) {
		if (error instanceof ChemistryInputError) throw error;
		throw new ChemistryInputError("The saved editor document could not be read.");
	}
}
