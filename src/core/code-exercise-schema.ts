/** Shared authoring schema for a code exercise, consumed by Teaching's ask tool,
 *  Practice's problem tool, and documented alongside the runtime parser.
 *  JSON-schema string lengths count characters; the byte-based bounds are
 *  enforced by parseCodeExercise at runtime. */
import { Type } from "typebox";
import { CODE_SOURCE_LIMIT, CODE_TEST_LIMIT, CODE_TEST_TEXT_LIMIT } from "./code-workspace.ts";
import { CODE_PROFILES, executableCodeLanguages } from "./code-language-catalog.ts";

export interface CodeExerciseSchemaOptions {
	/** "canonical" admits only canonical language IDs; "tolerant" leaves alias handling to the parser. */
	languageInput: "canonical" | "tolerant";
	/** Reject unknown properties on the exercise and its tests. */
	closed: boolean;
	/** Describes the surrounding workspace for this consumer. */
	description?: string;
}

/** Requirements are conditioned on the selected language, never a blend that tells one
 *  language to use another's boilerplate. */
const profileInstructions = () => CODE_PROFILES.map(profile => `If language is ${profile.language}: ${profile.authoring.starterCode}`).join(" ");

export function codeExerciseSchema(options: CodeExerciseSchemaOptions) {
	const languages = executableCodeLanguages();
	const list = languages.map(language => `${language.id} (${language.label})`).join(", ");
	const closed = options.closed ? { additionalProperties: false } : {};
	// String-valued either way; the canonical form restricts to catalog IDs at validation time.
	const language = options.languageInput === "canonical"
		? Type.String({ enum: languages.map(entry => entry.id), description: `Language id. Executable languages: ${list}.` })
		: Type.String({ minLength: 1, maxLength: 32, description: `Language id. Executable languages: ${list}; omit codeExercise for other languages.` });
	return Type.Object({
		language,
		starterCode: Type.String({
			minLength: 1,
			maxLength: CODE_SOURCE_LIMIT,
			description:
				`${profileInstructions()} At most 64 KiB UTF-8. Builds and runs before the learner edits it, ` +
				"but must fail at least one test until solved. Never include the worked solution or external dependencies.",
		}),
		tests: Type.Array(Type.Object({
			name: Type.String({ minLength: 1, maxLength: 120, description: "Short description of the behavior this case checks." }),
			stdin: Type.String({ maxLength: CODE_TEST_TEXT_LIMIT, description: "Complete standard input for one run, at most 8 KiB UTF-8; use an empty string when no input is needed." }),
			expectedStdout: Type.String({ maxLength: CODE_TEST_TEXT_LIMIT, description: "Expected standard output for this input, at most 8 KiB UTF-8. Checks normalize CRLF and final newlines only." }),
		}, closed), {
			minItems: 1,
			maxItems: CODE_TEST_LIMIT,
			description: "One to twelve deterministic correctness checks, including relevant edge cases. A successful build alone does not establish correctness.",
		}),
	}, { ...closed, ...(options.description ? { description: options.description } : {}) });
}
