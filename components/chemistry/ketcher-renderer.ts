import { loadIndigo } from "./indigo-client";

/** Derive an SVG from the full native drawing, retaining arrow geometry. */
export async function drawMechanism(ket: string, dark = false): Promise<string> {
	try {
		const indigo = await loadIndigo();
		const options = new indigo.MapStringString();
		try {
			options.set("render-output-format", "svg");
			options.set("render-background-color", "-1,-1,-1");
			options.set("render-base-color", dark ? "0.90,0.92,0.95" : "0.12,0.14,0.17");
			options.set("render-coloring", dark ? "false" : "true");
			options.set("bond-length", "30");
			options.set("bond-length-unit", "px");
			options.set("render-font-size", "17");
			options.set("render-font-size-unit", "px");
			const encoded = indigo.render(ket, options);
			const svg = new TextDecoder().decode(Uint8Array.from(atob(encoded), byte => byte.charCodeAt(0)));
			if (!svg.includes("<svg")) throw new Error("The renderer returned no drawing.");
			return svg;
		} finally { options.delete(); }
	} catch (cause) {
		throw new Error("Could not draw the mechanism with its arrows. Try again.", { cause });
	}
}
