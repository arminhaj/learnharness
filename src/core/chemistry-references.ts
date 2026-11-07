import { fromMarkdown } from "mdast-util-from-markdown";
import {
	ChemistryInputError, MAX_CHEMISTRY_REQUEST_BYTES, parseMoleculeBlock, parseMoleculeSource,
	type MoleculeSource,
} from "./chemistry.ts";

export interface MoleculeReference {
	id: string;
	name: string;
	source: MoleculeSource;
}

export const MAX_MOLECULE_REFERENCES = 32;

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const invalidReferences = () => new ChemistryInputError("The saved molecule references could not be read.");

/** A local reference bank is separate from answer evidence. Only standalone
 * molecular sources are admitted; a whole synthesis is never hidden in a card. */
export function parseMoleculeReferences(value: unknown): MoleculeReference[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_MOLECULE_REFERENCES) throw invalidReferences();
	const ids = new Set<string>();
	let bytes = 2;
	const references = value.map((entry: unknown) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalidReferences();
		const input = entry as Record<string, unknown>;
		if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id) || ids.has(input.id)
			|| typeof input.name !== "string" || !input.name.trim() || input.name.length > 120 || /[\u0000-\u001f\u007f]/.test(input.name)) throw invalidReferences();
		if (input.source && typeof input.source === "object" && "steps" in input.source && input.source.steps !== undefined) throw invalidReferences();
		const source = parseMoleculeSource(input.source);
		const reference = { id: input.id, name: input.name.trim(), source };
		bytes += byteLength(reference) + (ids.size ? 1 : 0);
		if (bytes > MAX_CHEMISTRY_REQUEST_BYTES) throw invalidReferences();
		ids.add(input.id);
		return reference;
	});
	return references;
}

interface MarkdownNode {
	type: string;
	lang?: string | null;
	value?: string;
	children?: MarkdownNode[];
	position?: { start: { offset?: number }; end: { offset?: number } };
}

/** mdast also returns a code node for an unfinished stream. Confirm that the
 * source ends with a matching fence which was excluded from the code value. */
function completeFence(node: MarkdownNode, markdown: string): boolean {
	const start = node.position?.start.offset;
	const end = node.position?.end.offset;
	if (start === undefined || end === undefined) return false;
	const raw = markdown.slice(start, end).trimEnd();
	const opening = /^(`{3,}|~{3,})/.exec(raw)?.[1];
	const closing = /(?:^|\n)[ \t>]*([`~]{3,})[ \t]*$/.exec(raw)?.[1];
	if (!opening || !closing || closing.length < opening.length || [...closing].some(char => char !== opening[0])) return false;
	// A fence indented too far is code content, not a closing delimiter.
	return node.value?.trimEnd().split(/\r?\n/).at(-1)?.trim() !== closing;
}

function referenceIdentity(source: MoleculeSource): string {
	// Drawing/conformer identity matters: separate supplied depictions of one
	// chemical can be useful references for different stages of a mechanism.
	return source.ket ? `ket:${source.ket}` : source.molfile ? `molfile:${source.molfile}` : source.sdf ? `sdf:${source.sdf}` : `smiles:${source.smiles}`;
}

/** Two independent integer hashes keep ids stable when surrounding prose or
 * reference ordering changes, without needing browser or server crypto IO. */
function referenceId(identity: string): string {
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < identity.length; index++) {
		const code = identity.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second ^ code, 0x85ebca6b);
	}
	return `reference-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}

/** Callers supply only publicly displayed question/prose strings. This helper
 * never walks arbitrary tool objects, answer commitments, or model solutions. */
export function collectMoleculeReferences(markdown: readonly string[], additional: readonly MoleculeSource[] = []): MoleculeReference[] {
	const references: MoleculeReference[] = [];
	const identities = new Set<string>();
	const ids = new Set<string>();
	let bytes = 2;
	const addLeaf = (source: MoleculeSource) => {
		if (references.length >= MAX_MOLECULE_REFERENCES) return;
		const identity = referenceIdentity(source);
		if (identities.has(identity)) return;
		const label = source.label?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
		const name = (label || `Structure ${references.length + 1}`).slice(0, 120).replace(/[\uD800-\uDBFF]$/, "");
		const baseId = referenceId(identity);
		let id = baseId;
		let suffix = 1;
		while (ids.has(id)) id = `${baseId}-${suffix++}`;
		const reference = { id, name, source };
		const size = byteLength(reference) + (references.length ? 1 : 0);
		if (bytes + size > MAX_CHEMISTRY_REQUEST_BYTES) return;
		bytes += size;
		identities.add(identity);
		ids.add(id);
		references.push(reference);
	};
	const add = (value: MoleculeSource) => {
		try {
			const source = parseMoleculeSource(value);
			if (source.steps) {
				for (const { id: _id, name, ...step } of source.steps) addLeaf({ ...step, label: step.label || name });
			} else addLeaf(source);
		} catch { /* Invalid or incomplete authored structures do not become reusable references. */ }
	};
	let remainingMarkdownBytes = MAX_CHEMISTRY_REQUEST_BYTES;
	for (const text of markdown) {
		if (references.length >= MAX_MOLECULE_REFERENCES) break;
		if (typeof text !== "string" || text.length > remainingMarkdownBytes) continue;
		const size = new TextEncoder().encode(text).byteLength;
		if (size > remainingMarkdownBytes) continue;
		remainingMarkdownBytes -= size;
		const visit = (node: MarkdownNode) => {
			if (references.length >= MAX_MOLECULE_REFERENCES) return;
			if (node.type === "code" && (node.lang === "molecule" || node.lang === "smiles") && completeFence(node, text)) {
				try { add(parseMoleculeBlock(node.value ?? "", node.lang)); }
				catch { /* A rendered error or partial JSON is not a reference. */ }
			}
			for (const child of node.children ?? []) visit(child);
		};
		visit(fromMarkdown(text));
	}
	for (const source of additional) {
		if (references.length >= MAX_MOLECULE_REFERENCES) break;
		add(source);
	}
	return references;
}

interface ChemistryContextPart {
	type: string;
	text?: unknown;
	toolCallId?: unknown;
	state?: unknown;
}

interface ChemistryContextMessage {
	role?: unknown;
	parts: readonly ChemistryContextPart[];
}

const problemTools = new Set(["tool-quiz", "tool-probe", "tool-ask_user_question", "tool-explain", "tool-recall", "tool-problem"]);
const problemBoundary = (part: ChemistryContextPart) => problemTools.has(part.type) && part.state !== "output-error" && part.state !== "input-streaming";

/** Public prose introducing this exact subject. Assistant view groups may span
 * several answered questions, so the prior question is an explicit boundary. */
export function publicChemistryContext(messages: readonly ChemistryContextMessage[], subjectToolCallId: string): string[] {
	if (!subjectToolCallId) return [];
	const parts = messages.filter(message => message.role === "assistant").flatMap(message => message.parts);
	let end = -1;
	for (let index = parts.length - 1; index >= 0; index--) {
		const part = parts[index]!;
		if (problemTools.has(part.type) && part.toolCallId === subjectToolCallId) { end = index; break; }
	}
	if (end < 0 || !problemBoundary(parts[end]!)) return [];
	let start = end - 1;
	while (start >= 0 && !problemBoundary(parts[start]!)) start--;
	return parts.slice(start + 1, end).flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []);
}
