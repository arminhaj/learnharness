/** Exercise-owned symbol descriptions, independent of an editor or language server. */
export interface ExerciseCodeSymbol {
	name: string;
	kind: "class" | "type" | "enum" | "method" | "property" | "variable" | "constant" | "function" | "namespace";
	detail: string;
	documentation: string;
	/** Text to insert when it differs from the displayed symbol name. */
	insertText?: string;
	/** Used for simple local-variable inference; not a complete type checker. */
	resultType?: string;
}

export interface ExerciseCodeContext {
	symbols: readonly ExerciseCodeSymbol[];
	bindings: readonly { name: string; type: string }[];
	types: readonly {
		name: string;
		access: "member" | "scope";
		members: readonly ExerciseCodeSymbol[];
	}[];
}
