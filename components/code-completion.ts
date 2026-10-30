import { completeAnyWord, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { ExerciseCodeContext, ExerciseCodeSymbol } from "@/src/core";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];
type Bindings = Map<string, string | null>;
type Access = "." | "->" | "::";
type Site = { from: number; to: number; signature: string; symbols: readonly ExerciseCodeSymbol[]; global: boolean };

const scopes = new Set(["Program", "FunctionDefinition", "CompoundStatement", "LambdaExpression", "ForStatement", "ForLoop", "ForRangeLoop", "IfStatement", "WhileStatement", "SwitchStatement", "CatchClause", "NamespaceDefinition", "ClassSpecifier", "StructSpecifier"]);
const declarators = new Set(["Identifier", "InitDeclarator", "ReferenceDeclarator", "PointerDeclarator", "ArrayDeclarator", "FunctionDeclarator", "StructuredBindingDeclarator"]);
const nonCode = new Set(["LineComment", "BlockComment", "String", "RawString", "CharLiteral", "SystemLibString"]);
const identifier = /^[A-Za-z_]\w*$/;
const prefix = /^(?:[A-Za-z_]\w*)?$/;
const nodeKey = (node: SyntaxNode) => `${node.name}:${node.from}:${node.to}`;
const exerciseSection = { name: "Exercise API", rank: 0 };
const documentSection = { name: "From your code", rank: 1 };

function children(node: SyntaxNode): SyntaxNode[] {
	const result: SyntaxNode[] = [];
	for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
	return result;
}

/** This deliberately recognizes a small set of ordinary declarations. It does
 * not resolve aliases, overloads, arbitrary expressions, or C++ templates. */
function normalizedType(value: string): string {
	return value.replace(/\b(?:const|volatile|static|extern|mutable|register|constexpr|inline|typename)\b/g, "")
		.replace(/&/g, "").replace(/\s*::\s*/g, "::").replace(/\s*([<>*,])\s*/g, "$1").trim().replace(/\s+/g, " ");
}

function memberType(type: string | null | undefined, access: Access): string | null {
	if (!type || access === "::") return null;
	const value = normalizedType(type);
	if (access === ".") return value.endsWith("*") ? null : value;
	if (value.endsWith("*")) return value.slice(0, -1);
	return /^std::optional<([^<>]+)>$/.exec(value)?.[1] ?? null;
}

function variableNode(node: SyntaxNode): SyntaxNode | null {
	if (node.name === "Identifier") return node;
	if (!declarators.has(node.name) || node.name === "StructuredBindingDeclarator") return null;
	for (const child of children(node)) {
		const found = variableNode(child);
		if (found) return found;
	}
	return null;
}

function containingScope(node: SyntaxNode): SyntaxNode | null {
	for (let parent = node.parent; parent; parent = parent.parent) if (scopes.has(parent.name)) return parent;
	return null;
}

function knownMembers(context: ExerciseCodeContext, type: string | null): readonly ExerciseCodeSymbol[] {
	return type ? context.types.find(item => item.access === "member" && normalizedType(item.name) === type)?.members ?? [] : [];
}

function inferredResult(expression: SyntaxNode | undefined, state: EditorState, bindings: Bindings, context: ExerciseCodeContext): string | null {
	if (!expression) return null;
	const text = (node: SyntaxNode) => state.sliceDoc(node.from, node.to);
	if (expression.name === "Identifier") return bindings.get(text(expression)) ?? null;
	if (expression.name !== "CallExpression") return null;
	const callee = expression.firstChild;
	if (!callee) return null;
	if (callee.name === "FieldExpression") {
		const receiver = callee.firstChild;
		const member = callee.lastChild;
		if (!receiver || receiver.name !== "Identifier" || !member || member.name !== "FieldIdentifier") return null;
		const access = state.sliceDoc(receiver.to, member.from).trim();
		if (access !== "." && access !== "->") return null;
		const type = memberType(bindings.get(text(receiver)), access);
		return knownMembers(context, type).find(symbol => symbol.name === text(member))?.resultType ?? null;
	}
	return context.symbols.find(symbol => symbol.kind === "function" && symbol.name === text(callee))?.resultType ?? null;
}

function visibleBindings(state: EditorState, position: number, context: ExerciseCodeContext, tree: ReturnType<typeof syntaxTree>): Bindings {
	const bindings: Bindings = new Map(context.bindings.map(binding => [binding.name, normalizedType(binding.type)]));
	const activeScopes = new Set<string>();
	for (let node: SyntaxNode | null = tree.resolveInner(position, -1); node; node = node.parent) if (scopes.has(node.name)) activeScopes.add(nodeKey(node));
	tree.iterate({
		to: position,
		enter(ref) {
			const node = ref.node;
			if (scopes.has(node.name) && !activeScopes.has(nodeKey(node))) return false;
			if ((node.name !== "Declaration" && node.name !== "ParameterDeclaration") || node.to > position) return;
			const scope = containingScope(node);
			if (!scope || !activeScopes.has(nodeKey(scope))) return false;
			const parts = children(node);
			const first = parts.findIndex(part => declarators.has(part.name));
			if (first < 0) return false;
			const declaredType = state.sliceDoc(node.from, parts[first]!.from);
			for (let i = first; i < parts.length; i++) {
				const declarator = parts[i]!;
				if (!declarators.has(declarator.name)) continue;
				const base = declarator.name === "InitDeclarator" ? declarator.firstChild! : declarator;
				if (base.name === "StructuredBindingDeclarator") {
					for (const binding of children(base)) if (binding.name === "Identifier") bindings.set(state.sliceDoc(binding.from, binding.to), null);
					continue;
				}
				const nameNode = variableNode(base);
				if (!nameNode) continue;
				const name = state.sliceDoc(nameNode.from, nameNode.to);
				const decoration = state.sliceDoc(base.from, nameNode.from);
				if (base.name === "ArrayDeclarator" || base.name === "FunctionDeclarator") { bindings.set(name, null); continue; }
				if (/\bauto\b/.test(declaredType)) {
					const initializer = declarator.name === "InitDeclarator" ? base.nextSibling ?? undefined
						: parts[i + 1] && state.sliceDoc(base.to, parts[i + 1]!.from).includes("=") ? parts[i + 1] : undefined;
					const result = inferredResult(initializer, state, bindings, context);
					bindings.set(name, decoration.includes("*") && !result?.endsWith("*") ? null : result ? normalizedType(result) : null);
				} else {
					bindings.set(name, normalizedType(`${declaredType} ${decoration}`) || null);
				}
			}
			return false;
		},
	});
	return bindings;
}

function completionSite(state: EditorState, position: number, context: ExerciseCodeContext): Site | null {
	const tree = ensureSyntaxTree(state, position, 20) ?? syntaxTree(state);
	if (tree.length < position) return null;
	for (let node: SyntaxNode | null = tree.resolveInner(position, -1); node; node = node.parent) if (nonCode.has(node.name)) return null;
	const before = state.sliceDoc(0, position);
	const word = /\w*$/.exec(before)![0];
	if (!prefix.test(word)) return null;
	const from = position - word.length;
	const to = position + /^\w*/.exec(state.sliceDoc(position))![0].length;
	const left = before.slice(0, from).trimEnd();
	const access = /(->|::|\.)$/.exec(left)?.[1] as Access | undefined;
	const bindings = visibleBindings(state, position, context, tree);
	if (access) {
		const receiverText = left.slice(0, -access.length).trimEnd();
		const match = (access === "::" ? /((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)$/ : /([A-Za-z_]\w*)$/).exec(receiverText);
		if (!match || /(?:\.|->|::)$/.test(receiverText.slice(0, match.index).trimEnd())) return null;
		const receiver = match[1]!.replace(/\s*::\s*/g, "::");
		if (access === "::") {
			const direct = context.types.find(type => type.access === "scope" && type.name === receiver)?.members ?? [];
			const qualified = context.symbols.filter(symbol => symbol.name.startsWith(`${receiver}::`) && identifier.test(symbol.name.slice(receiver.length + 2)))
				.map(symbol => ({ ...symbol, name: symbol.name.slice(receiver.length + 2), insertText: symbol.insertText?.startsWith(`${receiver}::`) ? symbol.insertText.slice(receiver.length + 2) : symbol.insertText }));
			const symbols = [...new Map([...direct, ...qualified].map(symbol => [symbol.name, symbol])).values()];
			return symbols.length ? { from, to, signature: `scope:${receiver}`, symbols, global: false } : null;
		}
		const type = memberType(bindings.get(receiver), access);
		const symbols = knownMembers(context, type);
		return symbols.length ? { from, to, signature: `member:${receiver}:${access}:${type}`, symbols, global: false } : null;
	}
	const symbols = context.symbols.filter(symbol => {
		const member = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(symbol.name);
		if (member) return knownMembers(context, memberType(bindings.get(member[1]!), ".")).some(candidate => candidate.name === member[2]);
		return symbol.kind !== "variable" || !bindings.has(symbol.name) || !symbol.resultType || bindings.get(symbol.name) === normalizedType(symbol.resultType);
	});
	return { from, to, signature: `global:${symbols.map(symbol => symbol.name).join(",")}`, symbols, global: true };
}

function option(symbol: ExerciseCodeSymbol, following: string): Completion {
	// Replacing a partially typed name in an existing call/template should not
	// insert another argument list or template argument list.
	const existingArguments = (symbol.kind === "method" || symbol.kind === "function") && following.startsWith("(");
	const existingTemplate = symbol.kind === "type" && following.startsWith("<");
	return { label: symbol.name, type: symbol.kind, detail: symbol.detail, info: symbol.documentation, apply: existingArguments || existingTemplate ? symbol.name : symbol.insertText ?? symbol.name, section: exerciseSection, boost: 8 };
}

/** Exercise-supplied symbols plus small, scoped C++ inference. A language server
 * can replace this source later without changing the exercise metadata. */
export function createExerciseCompletionSource(context: ExerciseCodeContext): CompletionSource {
	return async (completion: CompletionContext): Promise<CompletionResult | null> => {
		const site = completionSite(completion.state, completion.pos, context);
		if (!site || (site.global && site.from === completion.pos && !completion.explicit)) return null;
		const following = completion.state.sliceDoc(site.to).trimStart();
		const options = new Map(site.symbols.map(symbol => [symbol.name, option(symbol, following)]));
		if (site.global) {
			const words = await completeAnyWord(completion);
			if (words?.from === site.from) for (const word of words.options) if (!options.has(word.label)) options.set(word.label, { ...word, section: documentSection });
		}
		if (!options.size) return null;
		return {
			from: site.from,
			to: site.to,
			options: [...options.values()],
			validFor(text, from, to, state) {
				if (!prefix.test(text)) return false;
				const next = completionSite(state, to, context);
				return next !== null && next.from === from && next.signature === site.signature
					&& state.sliceDoc(next.to).trimStart()[0] === following[0];
			},
		};
	};
}
