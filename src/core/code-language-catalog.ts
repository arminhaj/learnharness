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
	/** Profile-specific project guidance composed into workspace generation. */
	project: string;
	/** How checks run on the learner's computer, for prompts and tool wording. */
	runtime: string;
}

/** Display text for the profile's build phase; interpreted profiles name theirs differently. */
export interface CodeProfileLabels {
	buildPassed: string;
	buildFailed: string;
	buildOutput: string;
	toolchainUnavailable: string;
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
	/** "flat" supporting files sit beside the entry; "nested" may use relative subdirectories. */
	supportPaths: "flat" | "nested";
	/** Supporting sources keep their exact bytes and may be empty (e.g. a package `__init__.py`);
	 *  otherwise they must be nonempty and are trimmed, as C++ drafts always were. */
	exactSupportSource: boolean;
	authoring: CodeProfileAuthoring;
	labels: CodeProfileLabels;
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
	supportPaths: "flat",
	exactSupportSource: false,
	authoring: {
		starterCode:
			"Complete standalone C++20 source: includes, an unfinished function with a compiling placeholder body, " +
			"and main with stdin/stdout wiring.",
		project:
			"one editable file named solution.cpp; put the working harness, local interfaces, and fixtures in supportFiles " +
			"as flat .cpp/.hpp/.h files. All .cpp files are compiled together.",
		runtime: "Checks compile the program with the learner's local Clang or GCC (-std=c++20) and run it once per test.",
	},
	labels: { buildPassed: "Compiled", buildFailed: "Compilation failed", buildOutput: "Compiler output", toolchainUnavailable: "Compiler unavailable" },
};

export const PYTHON3_STDIO_PROFILE: CodeProfileDescriptor = {
	id: "python3-stdio",
	version: 1,
	language: "python",
	label: "Python 3.11+",
	checkKinds: ["stdio"],
	entryFilename: "solution.py",
	supportExtensions: [".py"],
	supportPaths: "nested",
	exactSupportSource: true,
	authoring: {
		starterCode:
			"Complete standalone Python 3.11+ source using only the standard library: imports, an unfinished function " +
			"whose placeholder body runs without raising (for example returns a default value), and top-level or main() code " +
			"that reads standard input and writes standard output.",
		project:
			"one editable file named solution.py; put the working harness modules and fixtures in supportFiles as relative " +
			".py module paths (for example helpers.py or pkg/util.py, which solution.py imports with ordinary imports). " +
			"Use only the standard library.",
		runtime: "Checks first syntax-validate every .py file without running it, then run solution.py once per test with the learner's local Python 3.11+ interpreter. No packages are installed.",
	},
	labels: { buildPassed: "Syntax valid", buildFailed: "Syntax check failed", buildOutput: "Syntax check output", toolchainUnavailable: "Python unavailable" },
};

export const CODE_PROFILES: readonly CodeProfileDescriptor[] = [CPP20_STDIO_PROFILE, PYTHON3_STDIO_PROFILE];

export const CODE_LANGUAGES = [
	{ id: "cpp", label: "C++20", aliases: ["c++", "cxx"], editor: { syntax: "cpp", assistance: true }, profiles: ["cpp20-stdio"] },
	{ id: "python", label: "Python 3.11+", aliases: ["py", "python3"], editor: { syntax: "python", assistance: false }, profiles: ["python3-stdio"] },
	// Rust is named for the workspace picker's types only. It has no implemented
	// profile, so it cannot pass executable validation.
	{ id: "rust", label: "Rust 2021", aliases: [], editor: { assistance: false }, profiles: [] },
] as const satisfies readonly CodeLanguageDescriptor[];

/** Every language the catalog recognizes, executable or not. */
export type CodeLanguageId = (typeof CODE_LANGUAGES)[number]["id"];

export function findCodeLanguage(input: unknown): CodeLanguageDescriptor | undefined {
	if (typeof input !== "string") return undefined;
	const name = input.trim().toLowerCase();
	return (CODE_LANGUAGES as readonly CodeLanguageDescriptor[]).find(language => language.id === name || language.aliases.includes(name));
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
	return (CODE_LANGUAGES as readonly CodeLanguageDescriptor[]).filter(language => executableProfileFor(language.id) !== undefined);
}

/** "C++20" or "C++20 and Rust 2021": names of what this build can execute, for prompts and copy. */
export function executableLanguageNames(): string {
	return executableCodeLanguages().map(language => language.label).join(" and ");
}

/** Canonical IDs of executable languages, e.g. "'cpp' or 'python'", for error text. */
export function executableLanguageIds(): string {
	return executableCodeLanguages().map(language => `'${language.id}'`).join(" or ");
}

/** Deterministic, catalog-generated description of what is executable and what each profile
 *  requires. Composed into the Teaching and Practice prompts after the editable prose (and any
 *  override of it), so tutor guidance always tracks the registered profiles. */
export function codeLanguagePromptSection(): string {
	const lines = executableCodeLanguages().flatMap(language => language.profiles.map(findCodeProfile))
		.filter((profile): profile is CodeProfileDescriptor => profile !== undefined)
		.map(profile => `- \`${profile.language}\` (${profile.label}): ${profile.authoring.starterCode} ${profile.authoring.runtime}`);
	return [
		"## Executable coding languages",
		"Set `codeExercise.language` to one canonical id below; each language's starter requirements apply only to that language. Any other language is not executable here: say so and keep the task conceptual instead of posing a codeExercise.",
		...lines,
	].join("\n");
}
