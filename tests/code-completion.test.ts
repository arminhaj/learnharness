import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState } from "@codemirror/state";
import { cpp } from "@codemirror/lang-cpp";
import { CompletionContext, insertCompletionText, type CompletionResult } from "@codemirror/autocomplete";
import { createExerciseCompletionSource } from "../components/code-completion.ts";
import { API_DEMO_CODE_CONTEXT } from "../src/core/api-code-completion.ts";

const source = createExerciseCompletionSource(API_DEMO_CODE_CONTEXT);
async function at(marked: string, explicit = false) {
	const position = marked.indexOf("¦");
	assert.notEqual(position, -1, "test source must mark the cursor");
	const state = EditorState.create({ doc: marked.replace("¦", ""), extensions: [cpp()] });
	const result = await source(new CompletionContext(state, position, explicit));
	return { state, position, result };
}
const labels = (result: CompletionResult | null) => result?.options.map(option => option.label) ?? [];
const methods = ["find_book", "borrow", "loan_count", "remaining_copies"];
const fields = ["id", "title", "available_copies"];

async function insert(marked: string, label: string) {
	const { state, position, result } = await at(marked, true);
	assert.ok(result);
	const completion = result.options.find(option => option.label === label);
	assert.ok(completion, `missing completion ${label}`);
	assert.equal(typeof completion.apply, "string");
	return { result, completion, text: state.update(insertCompletionText(state, completion.apply as string, result.from, result.to ?? position)).state.doc.toString() };
}

describe("exercise-aware C++ completion", () => {
	it("offers only the bound receiver's methods after a dot, including empty-prefix activation", async () => {
		const { result, position } = await at("// distracting_word\nvoid f() { library.¦ }");
		assert.ok(result);
		assert.deepEqual(labels(result), methods);
		assert.equal(result.from, position);
		assert.match(result.options[0]!.detail!, /optional<Book>/);
		assert.match(result.options[0]!.info as string, /ServiceUnavailable/);
	});
	it("replaces the method prefix and supplies the known argument without duplicating the receiver", async () => {
		const { text } = await insert("void f() { library.fi¦; }", "find_book");
		assert.equal(text, "void f() { library.find_book(book_id); }");
	});
	it("replaces the whole method identifier at a mid-word cursor without adding a second argument list", async () => {
		const { text } = await insert("void f() { library.fi¦nd_book(book_id); }", "find_book");
		assert.equal(text, "void f() { library.find_book(book_id); }");
	});
	it("completes scoped enum values and inserts fully qualified global conveniences", async () => {
		const scoped = await insert("void f() { return BorrowResult::bor¦; }", "borrowed");
		assert.equal(scoped.text, "void f() { return BorrowResult::borrowed; }");
		assert.deepEqual(labels(scoped.result), ["borrowed", "unavailable", "not_found", "offline"]);
		const global = await insert("void f() { return Borr¦; }", "BorrowResult::borrowed");
		assert.equal(global.text, "void f() { return BorrowResult::borrowed; }");
		const method = await insert("void f() { borr¦; }", "library.borrow");
		assert.equal(method.text, "void f() { library.borrow(book_id); }");
	});
	it("completes explicit standard-library symbols without duplicate qualifiers or template arguments", async () => {
		assert.deepEqual(labels((await at("void f() { std::¦ }")).result), ["optional", "string", "nullopt"]);
		assert.equal((await insert("void f() { std::op¦; }", "optional")).text, "void f() { std::optional<Book>; }");
		assert.equal((await insert("void f() { std::op¦tional<Book> book; }", "optional")).text, "void f() { std::optional<Book> book; }");
	});
	it("infers optional result members and arrow access to a Book from a known call", async () => {
		const before = 'void f() { auto book = library.find_book("dune"); ';
		assert.deepEqual(labels((await at(before + "book->ti¦; }")).result), fields);
		assert.deepEqual(labels((await at(before + "book.h¦; }")).result), ["has_value", "value"]);
		const value = before + "auto present = book.value(); present.t¦; }";
		assert.deepEqual(labels((await at(value)).result), fields);
	});
	it("reads renamed reference parameters, pointer parameters, and explicit local types", async () => {
		assert.deepEqual(labels((await at("void f(LibraryApi& renamed) { renamed.f¦; }")).result), methods);
		assert.deepEqual(labels((await at("void f(LibraryApi* renamed) { renamed->f¦; }")).result), methods);
		assert.deepEqual(labels((await at("void f() { const Book& found = value; found.t¦; }")).result), fields);
		assert.deepEqual(labels((await at("void f() { std::optional<Book> candidate; candidate->t¦; }")).result), fields);
		assert.equal((await at("void f(LibraryApi* pointer) { pointer.f¦; }")).result, null);
		assert.equal((await at("void f() { Book value; value->t¦; }")).result, null);
	});
	it("keeps local inference inside its lexical scope and honors shadowing", async () => {
		assert.equal((await at("void one() { Book item; } void two() { item.t¦; }")).result, null);
		assert.equal((await at("void f() { int library = 0; library.f¦; }")).result, null);
		assert.equal((await at("void f() { auto library = unknown(); library.f¦; }")).result, null);
		assert.equal((await at('void f() { auto book = library.find_book("dune"); { int book; book->t¦; } }')).result, null);
		assert.deepEqual(labels((await at('void f() { auto book = library.find_book("dune"); { int book; } book->t¦; }')).result), fields);
	});
	it("does not leak known members or document words for an unknown or unsupported receiver", async () => {
		for (const code of ["unknown.fi¦", "Unknown::fi¦", "unknown.library.fi¦", "unknown->library.fi¦", "get_library().fi¦", "books[0].ti¦", "library.find_book(book_id)->ti¦"]) {
			assert.equal((await at(`void f() { ${code}; }`, true)).result, null, code);
		}
	});
	it("suppresses both API suggestions and document-word fallback inside C++ comments and literals", async () => {
		for (const code of [
			'void f() { // library.fi¦\n}', 'void f() { /* library.fi¦ */ }',
			'void f() { auto s = "library.fi¦"; }', 'void f() { auto s = "unfinished library.fi¦',
			'void f() { auto s = R"tag(library.fi¦)tag"; }', "void f() { char c = 'f¦'; }",
			'#include <library.fi¦>', '#include "library.fi¦"',
		]) assert.equal((await at(code, true)).result, null, code);
		assert.ok((await at("void f() { // done\n library.fi¦; }")).result);
	});
	it("supports explicit empty global completion and puts exercise symbols in the primary section", async () => {
		assert.equal((await at("void f() { ¦ }")).result, null);
		assert.ok(labels((await at("void f() { ¦ }", true)).result).includes("LibraryApi"));
		const { result } = await at("// borrowed\nvoid f() { borr¦; }");
		assert.ok(result);
		const known = result.options.find(option => option.label === "BorrowResult::borrowed")!;
		const word = result.options.find(option => option.label === "borrowed")!;
		assert.ok(word, "document words remain available in ordinary code context");
		assert.deepEqual(known.section, { name: "Exercise API", rank: 0 });
		assert.deepEqual(word.section, { name: "From your code", rank: 1 });
	});
	it("invalidates cached choices when the receiver, type, or code context changes", async () => {
		const original = await at("void f() { library.fi¦; }");
		assert.ok(original.result);
		const valid = original.result.validFor;
		assert.equal(typeof valid, "function");
		if (typeof valid !== "function") return;
		const extended = original.state.update({ changes: { from: original.position, insert: "nd" } }).state;
		assert.equal(valid("find", original.result.from, original.position + 2, extended), true);
		const replaced = await at("void f() { unknown.fi¦; }");
		assert.equal(valid("fi", original.result.from, replaced.position, replaced.state), false);
		const shadowed = await at("void f() { int library = 1; library.fi¦; }");
		assert.equal(valid("fi", shadowed.position - 2, shadowed.position, shadowed.state), false);
		const comment = await at("void f() { // library.fi¦\n}");
		assert.equal(valid("fi", comment.position - 2, comment.position, comment.state), false);
	});
});
