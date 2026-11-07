import type { CodeProfileReadiness } from "../core/code-readiness.ts";
import { executableCodeLanguages, executableProfileFor } from "../core/code-language-catalog.ts";
import type { CodeActivitySpec } from "../core/code-activity.ts";
import { executionSnapshotId } from "./code-snapshot.ts";
import type { CodeExecutionProvider } from "./code-provider.ts";
import { cppProvider } from "./cpp-provider.ts";
import { pythonProvider } from "./python-provider.ts";

/** Explicit registration: a profile executes only if the catalog implements it AND a provider is registered. */
const PROVIDERS: readonly CodeExecutionProvider[] = [cppProvider, pythonProvider];

export function providerForProfile(profileId: string): CodeExecutionProvider | undefined {
	return PROVIDERS.find(provider => provider.profileId === profileId);
}

export function providerForLanguage(language: unknown): CodeExecutionProvider | undefined {
	const profile = executableProfileFor(language);
	return profile ? providerForProfile(profile.id) : undefined;
}

/** Snapshot ID of a spec under its provider's effective build selection (default or trusted override). */
export function snapshotIdFor(spec: CodeActivitySpec, explicitSources?: string[]): string {
	const provider = providerForProfile(spec.profile.id);
	if (!provider) throw new Error(`No provider is registered for ${spec.profile.id}.`);
	return executionSnapshotId(spec, provider.buildSources(spec, explicitSources));
}

/** Serializable readiness of every implemented profile, probed on demand. Never gates parsing. */
export async function codeProfileReadiness(): Promise<CodeProfileReadiness[]> {
	const profiles = executableCodeLanguages().flatMap(language => language.profiles);
	return Promise.all(profiles.map(async id => {
		try { return await (providerForProfile(id)?.readiness() ?? Promise.resolve({ profileId: id, state: "unavailable" as const, message: "No provider is registered for this profile." })); }
		catch { return { profileId: id, state: "unavailable" as const, message: "Runtime readiness could not be determined." }; }
	}));
}
