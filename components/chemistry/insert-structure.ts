import { CoordinateTransformation, fromPaste, prepareStructToRender, Vec2, type Ketcher } from "ketcher-core";
import { MAX_MOLECULE_ATOMS } from "@/src/core";

/** Add a disconnected molecule without moving the drawing or losing its undo history. */
export async function insertChemicalStructure(editor: Ketcher, structure: string, canInsert: () => boolean, dropPosition?: { clientX: number; clientY: number } | { modelX: number; modelY: number }): Promise<void> {
	const dropPoint = dropPosition
		? "modelX" in dropPosition ? new Vec2(dropPosition.modelX, dropPosition.modelY) : CoordinateTransformation.pageToModel(dropPosition, editor.editor.render)
		: undefined;
	const fragment = await prepareStructToRender(structure, editor.structService, editor);
	fragment.rescale();
	// Parsing can finish after the dialog closes or the user changes the drawing.
	// Everything above operates on the new fragment; check before touching canvas state.
	if (!canInsert()) throw new Error("The drawing changed or insertion was cancelled. Try adding the chemical again.");
	const drawing = editor.editor.struct();
	if (fragment.atoms.size === 0) throw new Error("This chemical has no atoms to add.");
	if (drawing.atoms.size + fragment.atoms.size > MAX_MOLECULE_ATOMS) {
		throw new Error(`The drawing can contain at most ${MAX_MOLECULE_ATOMS} atoms.`);
	}
	const bounds = drawing.getCoordBoundingBox();
	const include = (point: Vec2) => {
		bounds.min = Vec2.min(bounds.min, point);
		bounds.max = Vec2.max(bounds.max, point);
	};
	// Ketcher's structural bounds include shapes, text anchors and arrow
	// endpoints, but omit images, multi-tail arrows and curved-arrow bulges.
	for (const image of drawing.images.values()) image.getCornerPositions().forEach(include);
	for (const arrow of drawing.multitailArrows.values()) arrow.getReferencePositionsArray().forEach(include);
	for (const arrow of drawing.rxnArrows.values()) {
		const height = Math.abs(arrow.height ?? 0);
		if (!height) continue;
		for (const point of arrow.pos) {
			include(new Vec2(point.x - height, point.y - height));
			include(new Vec2(point.x + height, point.y + height));
		}
	}
	const bondLength = drawing.getAvgBondLength();
	const gap = 2 * (Number.isFinite(bondLength) && bondLength > 0 ? bondLength : 1);
	const position = dropPoint ?? new Vec2(bounds.max.x + gap, bounds.min.y);
	// Ketcher's positioned addFragment bypasses history. Its public paste action
	// adds fresh atom IDs and lets us record the complete insertion as one edit.
	const [action, , created] = fromPaste(editor.editor.render.ctab, fragment, position, 0, false, !dropPoint);
	editor.editor.update(action);
	editor.editor.selection({ atoms: created.atoms, bonds: created.bonds });
}
