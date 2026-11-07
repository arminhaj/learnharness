import type { CodeProfileReadiness } from "../core/code-readiness.ts";

/** Trusted server-side boundary for one execution profile. Providers own
 *  executable selection, fixed argv construction, scaffolding, and diagnostic
 *  extraction; model-authored data or HTTP requests never supply those.
 *  Nothing is probed at import time: readiness is computed on demand.
 *  The C++ provider arrives with the shared-execution migration. */
export interface CodeExecutionProvider {
	profileId: string;
	readiness(): Promise<CodeProfileReadiness>;
}
