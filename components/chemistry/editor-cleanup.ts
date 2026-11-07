import { ChemicalMimeType, type CleanData, type CleanResult, type StructService, type StructServiceOptions, type StructServiceProvider } from "ketcher-core";

type Molecule = {
	type: "molecule";
	atoms: { label: string; location: number[]; [key: string]: unknown }[];
	bonds?: { atoms: number[]; type: number; [key: string]: unknown }[];
	[key: string]: unknown;
};
type Node = { $ref?: string; type?: string; data?: { mode?: string } };
type Drawing = { root: { nodes: Node[]; connections?: unknown[]; [key: string]: unknown }; [key: string]: unknown };

const electronArrows = new Set(["elliptical-arc-arrow-open-angle", "elliptical-arc-arrow-open-half-angle"]);

function molecule(drawing: Drawing, node: Node): Molecule | undefined {
	const value = node.$ref ? drawing[node.$ref] as Molecule | undefined : undefined;
	return value?.type === "molecule" && Array.isArray(value.atoms) ? value : undefined;
}

function keepDrawingScale(original: Molecule, replacement: Molecule): void {
	const length = (value: Molecule) => (value.bonds ?? []).reduce((sum, bond) => {
		const a = value.atoms[bond.atoms[0]!]!.location;
		const b = value.atoms[bond.atoms[1]!]!.location;
		return sum + Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
	}, 0);
	const center = (value: Molecule) => value.atoms.reduce((sum, atom) => [sum[0]! + atom.location[0]! / value.atoms.length, sum[1]! + atom.location[1]! / value.atoms.length], [0, 0]);
	const beforeLength = length(original), afterLength = length(replacement);
	const scale = beforeLength > 0 && afterLength > 0 ? beforeLength / afterLength : 1;
	const beforeCenter = center(original), afterCenter = center(replacement);
	// Ketcher's load() always rescales the WHOLE drawing by average bond length.
	// Keeping this fragment's total bond length avoids moving all other objects.
	for (const atom of replacement.atoms) {
		atom.location[0] = beforeCenter[0]! + (atom.location[0]! - afterCenter[0]!) * scale;
		atom.location[1] = beforeCenter[1]! + (atom.location[1]! - afterCenter[1]!) * scale;
	}
	if (original.stereoFlagPosition) replacement.stereoFlagPosition = original.stereoFlagPosition;
	else delete replacement.stereoFlagPosition;
}

/** Indigo treats curved electron arrows as reactions, whose selected-atom cleanup fails. */
async function cleanSelection(clean: StructService["clean"], data: CleanData, options?: StructServiceOptions): Promise<CleanResult> {
	if (!data.selected?.length || data.output_format !== ChemicalMimeType.KET) return clean(data, options);
	const drawing = JSON.parse(data.struct) as Drawing;
	const nodes = drawing.root?.nodes;
	if (!Array.isArray(nodes) || !nodes.some(node => node.type === "arrow" && electronArrows.has(node.data?.mode ?? ""))) return clean(data, options);
	// Real reaction schemes and macromolecule connections keep the vendor path.
	if (drawing.root.connections?.length || nodes.some(node => node.$ref && !molecule(drawing, node)
		|| node.type === "multi-tailed-arrow" || node.type === "plus"
		|| node.type === "arrow" && !electronArrows.has(node.data?.mode ?? ""))) return clean(data, options);
	const selected = new Set(data.selected);
	let offset = 0;
	let cleaned = false;
	for (const node of nodes) {
		const original = molecule(drawing, node);
		if (!original) continue;
		const localSelection = original.atoms.flatMap((_, index) => selected.has(offset + index) ? [index] : []);
		offset += original.atoms.length;
		if (!localSelection.length) continue;
		// Requests are sequential: the standalone service shares one Clean event.
		const result = await clean({
			...data, selected: localSelection,
			struct: JSON.stringify({ ...drawing, root: { ...drawing.root, nodes: [node] } }),
		}, options);
		const output = JSON.parse(result.struct) as Drawing;
		const resultNodes = output.root?.nodes;
		const replacement = resultNodes?.length === 1 ? molecule(output, resultNodes[0]!) : undefined;
		// Merge only when Indigo retained the molecule's atom order and topology.
		// Nothing reaches the editor until every selected molecule has succeeded.
		if (!replacement || replacement.atoms.length !== original.atoms.length
			|| replacement.atoms.some((atom, index) => atom.label !== original.atoms[index]!.label)
			|| JSON.stringify((replacement.bonds ?? []).map(bond => [bond.atoms, bond.type]))
				!== JSON.stringify((original.bonds ?? []).map(bond => [bond.atoms, bond.type]))) {
			throw new Error("Could not safely clean the selected molecule. The drawing has not been changed.");
		}
		keepDrawingScale(original, replacement);
		drawing[node.$ref!] = replacement;
		cleaned = true;
	}
	if (!cleaned || data.selected.some(index => !Number.isInteger(index) || index < 0 || index >= offset)) {
		throw new Error("Select atoms or bonds in a molecule before cleaning it.");
	}
	return { struct: JSON.stringify(drawing), format: ChemicalMimeType.KET };
}

export function withEditorCleanup(provider: StructServiceProvider): StructServiceProvider {
	return {
		mode: provider.mode,
		createStructService(options) {
			const service = provider.createStructService(options);
			const clean = service.clean.bind(service);
			service.clean = (data, options) => cleanSelection(clean, data, options);
			return service;
		},
	};
}

/** Vendor typings say string, but rejected worker operations pass Error objects. */
export function editorErrorMessage(reason: unknown): string {
	if (typeof reason === "string" && reason.trim()) return reason;
	if (reason && typeof reason === "object" && "message" in reason && typeof reason.message === "string" && reason.message.trim()) return reason.message;
	return "Could not complete this drawing operation.";
}
