import type { Message } from "@earendil-works/pi-ai";
import { parseMoleculeSource, type MoleculeSource } from "./chemistry.ts";

/** A request-only representation. The saved document and portable molecule
 * fences stay unchanged. Keep Molfile/SMILES verbatim and every editor field:
 * parsing KET removes indentation and double JSON escaping, not chemistry.
 * In a synthesis, firstStep supplies the root's identical molecular encodings.
 */
export const CHEMISTRY_CONTEXT_FORMAT = "chemistry-context-v1";

function readJson(text: string): unknown {
	return JSON.parse(text, (_key, value: unknown) => {
		// An unfamiliar editor field must not be rounded or changed to null
		// merely because it was parsed. Such documents keep their raw fence.
		if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0)
			|| (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
			throw new Error("JSON number cannot be preserved exactly");
		}
		return value;
	});
}

function projectedMolecule(source: MoleculeSource): Record<string, unknown> {
	// Validate bounds and the first-step mirror before omitting any repetition.
	parseMoleculeSource(source);
	const out = { ...source } as Record<string, unknown>;
	if (source.ket !== undefined) out.ket = readJson(source.ket);
	if (source.steps) {
		if (Object.hasOwn(source, "firstStep")) throw new Error("Ambiguous first step");
		out.steps = source.steps.map(step => projectedMolecule(step));
		out.firstStep = source.steps[0]!.id;
		for (const key of ["molfile", "smiles", "ket", "sdf"]) delete out[key];
	}
	return out;
}

/** Never use a prose summary or infer arrow endpoints. Unknown editor fields,
 * atom coordinates, stereo flags, charges, and full/fishhook arrows survive as
 * native JSON values. Invalid inputs keep the original representation.
 */
export function compactMoleculeForModel(source: MoleculeSource): string {
	const original = "```molecule\n" + JSON.stringify(source) + "\n```";
	try {
		const compact = "```chemistry-context\n" + JSON.stringify({
			format: CHEMISTRY_CONTEXT_FORMAT,
			molecule: projectedMolecule(source),
		}) + "\n```";
		return compact.length < original.length ? compact : original;
	} catch {
		return original;
	}
}

function compactFences(text: string): string {
	// Complete fences only; partial, malformed, and unrelated text is inert.
	return text.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*molecule[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\2[ \t]*(?=\r?(?:\n|$))/g,
		(original, prefix: string, _fence: string, body: string) => {
			try {
				const source = readJson(body) as MoleculeSource;
				const compact = compactMoleculeForModel(source);
				return compact.startsWith("```chemistry-context\n") && prefix.length + compact.length < original.length
					? prefix + compact : original;
			} catch { return original; }
		});
}

function compactText(text: string): string {
	if (!text.includes("molecule")) return text;
	// Learner answers wrap their molecule fence in JSON. Compact the string
	// before reserializing, rather than trying to match escaped fence content.
	if (text.trimStart().startsWith("{")) {
		try {
			const answer = readJson(text) as Record<string, unknown>;
			if (typeof answer.molecule === "string") {
				const molecule = compactFences(answer.molecule);
				if (molecule !== answer.molecule) return JSON.stringify({ ...answer, molecule });
			}
		} catch { /* Ordinary Markdown, not a serialized learner answer. */ }
	}
	return compactFences(text);
}

/** Copy only changed learner/tool text. Assistant messages (including signed
 * thinking and tool arguments), system prompts, images, and tool metadata are
 * never rewritten. This runs after the existing history-compaction cut.
 */
export function compactChemistryMessages(messages: readonly Message[]): Message[] {
	return messages.map(message => {
		if (message.role !== "user" && message.role !== "toolResult") return message;
		if (message.role === "user" && typeof message.content === "string") {
			const content = compactText(message.content);
			return content === message.content ? message : { ...message, content };
		}
		if (!Array.isArray(message.content)) return message;
		let changed = false;
		const content = message.content.map(block => {
			if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return block;
			const text = compactText(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		});
		return changed ? { ...message, content } as Message : message;
	});
}
