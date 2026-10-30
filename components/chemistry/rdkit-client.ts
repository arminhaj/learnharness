import type { MainModule } from "@rdkit/rdkit";
import { MAX_MOLECULE_ATOMS, moleculeInput, type MoleculeSource } from "@/src/core";

declare global {
	interface Window { initRDKitModule?: (options?: unknown) => Promise<MainModule> }
}
let ready: Promise<MainModule> | undefined;
export function loadRDKit(): Promise<MainModule> {
	if (!ready) {
		ready = new Promise<void>((resolve, reject) => {
			if (window.initRDKitModule) { resolve(); return; }
			const script = document.createElement("script");
			script.src = "/chemistry/RDKit_minimal.js";
			script.onload = () => resolve();
			script.onerror = () => { script.remove(); reject(new Error("The molecule renderer could not load. Try again.")); };
			document.head.appendChild(script);
		}).then(() => {
			if (!window.initRDKitModule) throw new Error("The molecule renderer is unavailable.");
			return window.initRDKitModule({ locateFile: (name: string) => `/chemistry/${name}` });
		}).catch((error) => { ready = undefined; throw error; });
	}
	return ready;
}

const drawings = new Map<string, string>();
export async function drawMolecule(source: MoleculeSource, dark = false): Promise<string> {
	const input = moleculeInput(source);
	const key = JSON.stringify([input, dark]);
	const cached = drawings.get(key);
	if (cached) return cached;
	const rdkit = await loadRDKit();
	let molecule;
	try {
		molecule = rdkit.get_mol(input);
		if (!molecule || molecule.get_num_atoms() === 0) throw new Error("Could not read this molecular structure.");
		if (molecule.get_num_atoms() > MAX_MOLECULE_ATOMS) throw new Error("This structure is too large for an inline drawing.");
		// Imported 3D coordinates need a fresh 2D layout, not a projection.
		if (molecule.has_coords() !== 2) molecule.set_new_coords();
		const ink = dark ? [0.90, 0.92, 0.95] : [0.12, 0.14, 0.17];
		const svg = molecule.get_svg_with_highlights(JSON.stringify({
			width: -1, height: -1, fixedBondLength: 30, fixedFontSize: 17,
			bondLineWidth: 1.8, padding: 0.14, clearBackground: false,
			atomColourPalette: { "-1": ink, "0": ink, "1": ink, "6": ink,
				"7": dark ? [0.50, 0.70, 1] : [0.15, 0.25, 0.80],
				"8": dark ? [1, 0.52, 0.52] : [0.80, 0.12, 0.15] },
		}));
		if (!svg.includes("<svg")) throw new Error("The structure could not be drawn.");
		if (drawings.size >= 128) drawings.delete(drawings.keys().next().value!);
		drawings.set(key, svg);
		return svg;
	} catch (error) {
		throw error instanceof Error ? error : new Error("Could not read this molecular structure.");
	} finally { molecule?.delete(); }
}
