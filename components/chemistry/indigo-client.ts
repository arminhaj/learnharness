import createIndigo, { type IndigoModule } from "indigo-ketcher";

let ready: Promise<IndigoModule> | undefined;

export function loadIndigo(): Promise<IndigoModule> {
	if (!ready) {
		// This entry point embeds its WASM locally. Direct calls avoid the
		// editor-bound standalone service's shared worker and callbacks.
		ready = createIndigo().catch(error => { ready = undefined; throw error; });
	}
	return ready;
}

/** Convert the molecule-only snapshot without sharing editor worker events. */
export async function smilesFromMolfile(molfile: string): Promise<string> {
	try {
		const indigo = await loadIndigo();
		const options = new indigo.MapStringString();
		try {
			const smiles = indigo.convert(molfile, "smiles", options).trim();
			if (!smiles) throw new Error("The drawing contains no molecule.");
			return smiles;
		} finally { options.delete(); }
	} catch (cause) {
		throw new Error("Could not convert the drawn structure to SMILES.", { cause });
	}
}
