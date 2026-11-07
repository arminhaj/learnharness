import { KetSerializer, MolSerializer, type Ketcher } from "ketcher-core";
import type { MoleculeDocument } from "@/src/core";
import { smilesFromMolfile } from "./indigo-client";

/** Capture one complete drawing, then derive chemistry from that same snapshot.
 * Ketcher's ordinary molecule exporters treat electron-flow arrows as reactions. */
export async function snapshotEditor(editor: Pick<Ketcher, "getKet">, label?: string): Promise<MoleculeDocument> {
	const ket = await editor.getKet();
	return snapshotDrawing(ket, label);
}

export async function snapshotDrawing(ket: string, label?: string): Promise<MoleculeDocument> {
	const drawing = new KetSerializer().deserialize(ket);
	if (!drawing.atoms.size) throw new Error("Draw a structure before saving it.");
	// Validation at save/submission checks the full KET against this graph.
	const molfile = new MolSerializer().serialize(drawing.clone(null, null, true));
	const smiles = (await smilesFromMolfile(molfile)).trim();
	if (!smiles) throw new Error("Draw a structure before saving it.");
	return { version: 1, molfile, smiles, ket, ...(label && { label }) };
}
