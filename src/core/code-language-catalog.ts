/** Browser-safe catalog of code languages and execution profiles.
 *  Descriptors say what this build implements. They never probe tools: whether
 *  this server can execute a profile right now is a separate readiness view
 *  (see CodeProfileReadiness), and it never affects saved-content validation. */

export type CodeCheckKind = "stdio";

export interface CodeEditorCapabilities {
	/** Editor-provider key for syntax support; plain editing when absent. */
	syntax?: string;
	/** Whether an editor-side completion/hint provider exists for the language. */
	assistance: boolean;
}

export interface CodeProfileAuthoring {
	/** Profile-specific instruction composed into the common starterCode wording. */
	starterCode: string;
}

/** A supported workflow for a language. Only implemented profiles are listed. */
export interface CodeProfileDescriptor {
	id: string;
	version: number;
	language: string;
	label: string;
	checkKinds: readonly CodeCheckKind[];
	/** Editable entry-point filename. */
	entryFilename: string;
	/** Extensions allowed for supporting source resources. */
	supportExtensions: readonly string[];
	authoring: CodeProfileAuthoring;
}

export interface CodeLanguageDescriptor {
	/** Canonical language ID. */
	id: string;
	label: string;
	/** Accepted input spellings, lowercase; the canonical ID is always accepted. */
	aliases: readonly string[];
	editor: CodeEditorCapabilities;
	/** Implemented execution profile IDs; empty means not executable in this build. */
	profiles: readonly string[];
}

export const CPP20_STDIO_PROFILE: CodeProfileDescriptor = {
	id: "cpp20-stdio",
	version: 1,
	language: "cpp",
	label: "C++20",
	checkKinds: ["stdio"],
	entryFilename: "solution.cpp",
	supportExtensions: [".cpp", ".h", ".hpp"],
	authoring: {
		starterCode:
			"Complete standalone C++20 source: includes, an unfinished function with a compiling placeholder body, " +
			"and main with stdin/stdout wiring.",
	},
};

export const CODE_PROFILES: readonly CodeProfileDescriptor[] = [CPP20_STDIO_PROFILE];

export const CODE_LANGUAGES: readonly CodeLanguageDescriptor[] = [
	{ id: "cpp", label: "C++20", aliases: ["c++", "cxx"], editor: { syntax: "cpp", assistance: true }, profiles: ["cpp20-stdio"] },
	// Rust is named for the workspace picker's types only. It has no implemented
	// profile, so it cannot pass executable validation.
	{ id: "rust", label: "Rust 2021", aliases: [], editor: { assistance: false }, profiles: [] },
];

export function findCodeLanguage(input: unknown): CodeLanguageDescriptor | undefined {
	if (typeof input !== "string") return undefined;
	const name = input.trim().toLowerCase();
	return CODE_LANGUAGES.find(language => language.id === name || language.aliases.includes(name));
}

export function findCodeProfile(id: unknown): CodeProfileDescriptor | undefined {
	return CODE_PROFILES.find(profile => profile.id === id);
}

/** The profile an input language ID/alias runs under, or undefined (fail closed). */
export function executableProfileFor(input: unknown): CodeProfileDescriptor | undefined {
	const language = findCodeLanguage(input);
	if (!language) return undefined;
	for (const id of language.profiles) {
		const profile = findCodeProfile(id);
		if (profile) return profile;
	}
	return undefined;
}

export function executableCodeLanguages(): CodeLanguageDescriptor[] {
	return CODE_LANGUAGES.filter(language => executableProfileFor(language.id) !== undefined);
}
