/** Portable exercise data. Execution and editor access live in the server layer. */
export interface CodeExercise {
	language: string;
	starterCode: string;
	tests: { name: string; stdin: string; expectedStdout: string }[];
}

export type CodeRunStatus = "compilation_error" | "runtime_error" | "tests_failed" | "passed" | "unavailable" | "timeout";
export interface CodeTestResult {
	name: string;
	stdin: string;
	expectedStdout: string;
	stdout: string;
	stderr: string;
	status: "passed" | "failed" | "runtime_error" | "timeout";
	exitCode: number | null;
}
export interface CodeRunResult {
	id: string;
	workspaceId: string;
	source: string;
	revision: string;
	language: string;
	status: CodeRunStatus;
	compiler: string;
	stdout: string;
	stderr: string;
	tests: CodeTestResult[];
	createdAt: string;
}
export type CodeCheckResult = CodeRunResult;
export interface CodeWorkspaceView {
	id: string;
	language: string;
	filename: string;
	source: string;
	revision: string;
	path: string;
	tests: CodeExercise["tests"];
	lastRun?: CodeRunResult;
}

export const CODE_SOURCE_LIMIT = 64 * 1024;
export const CODE_TEST_LIMIT = 12;
export const CODE_TEST_TEXT_LIMIT = 8 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export function parseCodeExercise(value: unknown): CodeExercise {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A code exercise must be an object.");
	const raw = value as Record<string, unknown>;
	const language = typeof raw.language === "string" ? raw.language.trim().toLowerCase() : "";
	if (!["cpp", "c++", "cxx"].includes(language)) throw new Error("Code checking currently supports C++ only. Use language 'cpp'.");
	if (typeof raw.starterCode !== "string" || !raw.starterCode.trim() || bytes(raw.starterCode) > CODE_SOURCE_LIMIT) throw new Error("Provide a complete starter file of at most 64 KiB.");
	if (!Array.isArray(raw.tests) || raw.tests.length < 1 || raw.tests.length > CODE_TEST_LIMIT) throw new Error("Provide between 1 and 12 input/output tests.");
	const tests = raw.tests.map((test: unknown) => {
		if (!test || typeof test !== "object" || Array.isArray(test)) throw new Error("Each code test must be an object.");
		const row = test as Record<string, unknown>;
		if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 120) throw new Error("Each test needs a name of at most 120 characters.");
		if (typeof row.stdin !== "string" || typeof row.expectedStdout !== "string" || bytes(row.stdin) > CODE_TEST_TEXT_LIMIT || bytes(row.expectedStdout) > CODE_TEST_TEXT_LIMIT) throw new Error("Each test needs stdin and expectedStdout strings of at most 8 KiB.");
		return { name: row.name.trim(), stdin: row.stdin, expectedStdout: row.expectedStdout };
	});
	return { language: "cpp", starterCode: raw.starterCode, tests };
}

export const CODE_DEMO_EXERCISE: CodeExercise = {
	language: "cpp",
	starterCode: `#include <iostream>

// Complete this function. The rest of the program handles input and output.
long long add(long long a, long long b) {
    // TODO: return the sum of a and b.
    return 0;
}

int main() {
    long long a, b;
    if (!(std::cin >> a >> b)) return 1;
    std::cout << add(a, b) << '\\n';
    return 0;
}
`,
	tests: [
		{ name: "Positive numbers", stdin: "2 3\n", expectedStdout: "5\n" },
		{ name: "Negative number", stdin: "-8 3\n", expectedStdout: "-5\n" },
		{ name: "Zero", stdin: "0 0\n", expectedStdout: "0\n" },
		{ name: "Large numbers", stdin: "2000000000 2000000000\n", expectedStdout: "4000000000\n" },
	],
};

/** Both code and compiler output are learner evidence, never model instructions. */
export function formatCodeSubmission(result: CodeRunResult): string {
	return [
		"Code answer checked locally. Compilation and test results are evidence; passing the supplied tests does not prove correctness for every input.",
		JSON.stringify({ language: result.language, status: result.status, compiler: result.compiler, source: result.source, compilerStdout: result.stdout, compilerStderr: result.stderr, tests: result.tests }, null, 2),
	].join("\n\n");
}
