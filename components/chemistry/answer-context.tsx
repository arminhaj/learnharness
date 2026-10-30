"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { MoleculeSource } from "@/src/core";

const ChemistryAnswerContext = createContext<((source: MoleculeSource) => void) | null>(null);
export function ChemistryAnswerProvider({ onUse, children }: { onUse?: (source: MoleculeSource) => void; children: ReactNode }) {
	return <ChemistryAnswerContext.Provider value={onUse ?? null}>{children}</ChemistryAnswerContext.Provider>;
}
export function useChemistryAnswer() { return useContext(ChemistryAnswerContext); }
