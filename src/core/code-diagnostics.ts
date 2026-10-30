import type { ExerciseCodeContext } from "./code-completion.ts";

/** One-based source positions; endColumn is exclusive when present. */
export interface ExerciseCodeDiagnostic {
	line: number;
	column: number;
	endColumn?: number;
	severity: "error" | "warning";
	message: string;
	source?: string;
}

/** Parse actual Clang/GCC output without attributing supporting-file errors to the answer. */
export function parseCompilerDiagnostics(output: string, filename = "solution.cpp"): ExerciseCodeDiagnostic[] {
	const requested = filename.replace(/\\/g, "/").replace(/^\.\//, "");
	const diagnostics: ExerciseCodeDiagnostic[] = [];
	const seen = new Set<string>();
	for (const line of output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/)) {
		const match = /^(.+):(\d+):(\d+):\s*(fatal error|error|warning):\s*(.+)$/.exec(line);
		if (!match) continue;
		const file = match[1]!.replace(/\\/g, "/").replace(/^\.\//, "");
		if (file !== requested && !file.endsWith(`/${requested}`)) continue;
		const row = Number(match[2]), column = Number(match[3]);
		if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column) || row < 1 || column < 1) continue;
		const diagnostic: ExerciseCodeDiagnostic = { line: row, column, severity: match[4] === "warning" ? "warning" : "error", message: match[5]!, source: "compiler" };
		const key = JSON.stringify(diagnostic);
		if (!seen.has(key)) { diagnostics.push(diagnostic); seen.add(key); }
	}
	return diagnostics;
}

interface Token { value: string; start: number; end: number; }
const identifier = /^[A-Za-z_]\w*$/;

/** Preserve positions while removing comments, literals, and preprocessor lines. */
function codeOnly(source: string): { code: string; macros: Set<string> } {
	const masked = source.split("");
	const macros = new Set<string>();
	const hide = (start: number, end: number) => { for (let i = start; i < end; i++) if (source[i] !== "\n" && source[i] !== "\r") masked[i] = " "; };
	for (let i = 0; i < source.length;) {
		if (source.startsWith("//", i)) {
			const end = source.indexOf("\n", i); const to = end < 0 ? source.length : end;
			hide(i, to); i = to; continue;
		}
		if (source.startsWith("/*", i)) {
			const end = source.indexOf("*/", i + 2); const to = end < 0 ? source.length : end + 2;
			hide(i, to); i = to; continue;
		}
		const raw = /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/.exec(source.slice(i));
		if (raw) {
			const closing = `)${raw[1]}"`;
			const end = source.indexOf(closing, i + raw[0].length); const to = end < 0 ? source.length : end + closing.length;
			hide(i, to); i = to; continue;
		}
		if (source[i] === '"' || source[i] === "'") {
			// C++ digit separators are not character literals.
			if (source[i] === "'" && /[0-9A-Fa-f]/.test(source[i - 1] ?? "") && /[0-9A-Fa-f]/.test(source[i + 1] ?? "")) { i++; continue; }
			const quote = source[i]; let end = i + 1;
			while (end < source.length) { if (source[end] === "\\") { end += 2; continue; } if (source[end++] === quote) break; }
			hide(i, Math.min(end, source.length)); i = end; continue;
		}
		if (source[i] === "#" && /^\s*$/.test(source.slice(source.lastIndexOf("\n", i - 1) + 1, i))) {
			const define = /^#\s*define\s+([A-Za-z_]\w*)/.exec(source.slice(i));
			if (define) macros.add(define[1]!);
			let end = i;
			do { const next = source.indexOf("\n", end); end = next < 0 ? source.length : next + 1; } while (end < source.length && /\\\r?\n$/.test(source.slice(i, end)));
			hide(i, end); i = end; continue;
		}
		i++;
	}
	return { code: masked.join(""), macros };
}

const notTypes = new Set(["return", "co_return", "throw", "case", "delete", "new", "sizeof", "alignof", "decltype", "noexcept", "if", "else", "while", "for", "switch", "do", "goto", "break", "continue", "true", "false", "nullptr"]);
function declarationPrefix(tokens: Token[], index: number): string | undefined {
	let before = index - 1;
	while (["&", "&&", "*"].includes(tokens[before]?.value ?? "")) before--;
	const previous = tokens[before]?.value;
	if (previous && identifier.test(previous) && !notTypes.has(previous)) {
		// A qualified value in an expression is not a type declaration.
		if ([".", "->"].includes(tokens[before - 1]?.value ?? "")) return;
		return tokens.slice(Math.max(0, before - 4), index).map((token) => token.value).join(" ");
	}
	if (previous === ">") return "template type";
	// A function-pointer declaration: bool (*borrow)(...).
	if (tokens[index - 1]?.value === "*" && tokens[index - 2]?.value === "(") return "function pointer";
	return;
}

/** Targeted exercise hints, not a parser, compiler, or complete C++ type checker.
 * Ambiguous imports/declarations suppress hints rather than inventing errors. */
export function findExerciseCodeDiagnostics(source: string, context: ExerciseCodeContext): ExerciseCodeDiagnostic[] {
	const { code, macros } = codeOnly(source);
	const tokens: Token[] = Array.from(code.matchAll(/[A-Za-z_]\w*|\d+(?:\.\d+)?|::|->|&&|\|\||[^\s]/g), (match) => ({ value: match[0], start: match.index!, end: match.index! + match[0].length }));
	const diagnostics: ExerciseCodeDiagnostic[] = [];
	const declared = new Set([...macros, ...context.symbols.filter((symbol) => identifier.test(symbol.name)).map((symbol) => symbol.name)]);
	const bindingShadowed = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const prefix = declarationPrefix(tokens, i);
		if (identifier.test(token.value) && prefix) {
			declared.add(token.value);
			const binding = context.bindings.find((entry) => entry.name === token.value);
			if (binding && !prefix.replace(/\s/g, "").includes(binding.type.replace(/\s/g, ""))) bindingShadowed.add(binding.name);
		}
		if (token.value === "using") {
			let last: Token | undefined;
			for (let j = i + 1; j < tokens.length && tokens[j]!.value !== ";"; j++) if (identifier.test(tokens[j]!.value)) last = tokens[j];
			if (last) declared.add(last.value);
		}
	}
	// Conservatively recognize unscoped enum members and structured-binding locals.
	for (const match of code.matchAll(/\benum(?:\s+class)?(?:\s+[A-Za-z_]\w*)?\s*\{([^{}]*)\}|\bauto\s*(?:&|&&)?\s*\[([^\]]*)\]/g)) {
		for (const part of (match[1] ?? match[2] ?? "").split(",")) {
			const name = /^\s*([A-Za-z_]\w*)/.exec(part)?.[1]; if (name) declared.add(name);
		}
	}
	const lineStarts = [0];
	for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
	const add = (token: Token, message: string) => {
		let low = 0, high = lineStarts.length;
		while (low + 1 < high) { const mid = (low + high) >> 1; if (lineStarts[mid]! <= token.start) low = mid; else high = mid; }
		const column = token.start - lineStarts[low]! + 1;
		diagnostics.push({ line: low + 1, column, endColumn: column + token.end - token.start, severity: "error", message, source: "exercise" });
	};
	const namespaceImport = /\busing\s+namespace\b/.test(code);
	const classBody = /\b(?:class|struct)\s+[A-Za-z_]\w*[^;{}]*\{/.test(code);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!identifier.test(token.value) || declared.has(token.value) || namespaceImport || [".", "->", "::"].includes(tokens[i - 1]?.value ?? "")) continue;
		if (tokens[i + 1]?.value === "(" && !classBody) {
			const bindings = context.bindings.filter((binding) => !bindingShadowed.has(binding.name) && context.types.some((type) => type.access === "member" && type.name === binding.type && type.members.some((member) => member.kind === "method" && member.name === token.value)));
			if (bindings.length === 1) { add(token, `Call this method on '${bindings[0]!.name}': ${bindings[0]!.name}.${token.value}(...).`); continue; }
		}
		const scopes = context.types.filter((type) => type.access === "scope" && type.members.some((member) => member.kind === "constant" && member.name === token.value));
		if (scopes.length === 1 && !new RegExp(`\\busing\\s+enum\\s+${scopes[0]!.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*;`).test(code)) add(token, `Use the scoped name '${scopes[0]!.name}::${token.value}'.`);
	}
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i]!.value !== "return") continue;
		let parentheses = 0, brackets = 0, braces = 0;
		for (let j = i + 1; j < tokens.length; j++) {
			const token = tokens[j]!;
			if (token.value === ";" && parentheses === 0 && brackets === 0 && braces === 0) break;
			if (token.value === "}" && braces === 0) {
				const expression = tokens.slice(i + 1, j);
				const hasMacro = expression.some((part) => macros.has(part.value) || /^[A-Z_][A-Z0-9_]*$/.test(part.value));
				if (!parentheses && !brackets && !hasMacro && !/^\s*#/m.test(source.slice(tokens[i]!.start, token.start))) add(tokens[j - 1] ?? tokens[i]!, "Add ';' after this return statement.");
				break;
			}
			if (token.value === "(") parentheses++; else if (token.value === ")") parentheses--;
			if (token.value === "[") brackets++; else if (token.value === "]") brackets--;
			if (token.value === "{") braces++; else if (token.value === "}") braces--;
			if (parentheses < 0 || brackets < 0 || braces < 0) break;
		}
	}
	return diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
}
