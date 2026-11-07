import { MAX_CHEMISTRY_REQUEST_BYTES, MAX_SYNTHESIS_STEPS, parseMoleculeDocument, parseMoleculeSource, type MoleculeDocument, type MoleculeSource } from "@/src/core";

export interface SynthesisDraftStep {
	id: string;
	name: string;
	source?: MoleculeSource;
	ket?: string;
}

/** Local editing state may include empty steps; submitted documents may not. */
export interface SynthesisEditorDraft {
	kind: "synthesis-draft";
	version: 1;
	activeStepId: string;
	steps: SynthesisDraftStep[];
	label?: string;
}

export type StructureEditorDraft = MoleculeDocument | SynthesisEditorDraft;

export function isSynthesisDraft(value: unknown): value is SynthesisEditorDraft {
	return !!value && typeof value === "object" && "kind" in value && value.kind === "synthesis-draft";
}

export function parseStructureEditorDraft(value: unknown): StructureEditorDraft {
	if (!isSynthesisDraft(value)) return parseMoleculeDocument(value);
	const invalid = () => new Error("The saved synthesis draft could not be read.");
	if (value.version !== 1 || !Array.isArray(value.steps) || !value.steps.length || value.steps.length > MAX_SYNTHESIS_STEPS
		|| new TextEncoder().encode(JSON.stringify(value)).length > MAX_CHEMISTRY_REQUEST_BYTES) throw invalid();
	if (value.label !== undefined && (typeof value.label !== "string" || value.label.length > 240)) throw invalid();
	const ids = new Set<string>();
	const steps = value.steps.map(step => {
		if (!step || typeof step !== "object" || typeof step.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(step.id)
			|| ids.has(step.id) || typeof step.name !== "string" || !step.name.trim() || step.name.length > 120 || /[\u0000-\u001f\u007f]/.test(step.name)) throw invalid();
		ids.add(step.id);
		if (step.ket !== undefined) {
			if (typeof step.ket !== "string" || step.ket.length > 500_000) throw invalid();
			const drawing: unknown = JSON.parse(step.ket);
			if (!drawing || typeof drawing !== "object" || Array.isArray(drawing)) throw invalid();
		}
		if (step.source?.steps !== undefined) throw invalid();
		const source = step.source !== undefined ? parseMoleculeSource(step.source) : undefined;
		return { id: step.id, name: step.name.trim(), ...(source && { source }), ...(step.ket !== undefined && { ket: step.ket }) };
	});
	if (typeof value.activeStepId !== "string" || !ids.has(value.activeStepId)) throw invalid();
	return { kind: "synthesis-draft", version: 1, activeStepId: value.activeStepId, steps, ...(value.label && { label: value.label }) };
}

export function initialSynthesisSteps(initial?: MoleculeSource | SynthesisEditorDraft): { steps: SynthesisDraftStep[]; activeStepId: string; synthesis: boolean } {
	if (isSynthesisDraft(initial)) return { steps: structuredClone(initial.steps), activeStepId: initial.activeStepId, synthesis: true };
	if (initial?.steps?.length) {
		const steps = initial.steps.map(({ id, name, ...source }) => ({ id, name, source }));
		return { steps, activeStepId: steps[0]!.id, synthesis: true };
	}
	return { steps: [{ id: "step-1", name: "Step 1", ...(initial && { source: initial }) }], activeStepId: "step-1", synthesis: false };
}
