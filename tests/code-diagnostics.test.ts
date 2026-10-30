import assert from "node:assert/strict";
import { test } from "node:test";
import { API_DEMO_CODE_CONTEXT } from "../src/core/api-code-completion.ts";
import { findExerciseCodeDiagnostics, parseCompilerDiagnostics } from "../src/core/code-diagnostics.ts";
import type { ExerciseCodeContext } from "../src/core/code-completion.ts";

const diagnose = (source: string) => findExerciseCodeDiagnostics(source, API_DEMO_CODE_CONTEXT);

test("compiler diagnostics parse Clang/GCC positions and ignore supporting files and notes", () => {
	const output = [
		"/tmp/build/solution.cpp:8:21: error: use of undeclared identifier 'borrow'",
		"    8 |     bool in_stock = borrow(book_id);",
		"      |                     ^~~~~~",
		"./solution.cpp:4:17: warning: unused parameter 'library' [-Wunused-parameter]",
		"solution.cpp:1:1: fatal error: missing header",
		"library_api.cpp:8:21: error: error in supporting implementation",
		"not_solution.cpp:2:3: error: a different file",
		"solution.cpp:8:21: note: diagnostic context",
	].join("\n");
	assert.deepEqual(parseCompilerDiagnostics(output), [
		{ line: 8, column: 21, severity: "error", message: "use of undeclared identifier 'borrow'", source: "compiler" },
		{ line: 4, column: 17, severity: "warning", message: "unused parameter 'library' [-Wunused-parameter]", source: "compiler" },
		{ line: 1, column: 1, severity: "error", message: "missing header", source: "compiler" },
	]);
});

test("compiler diagnostics accept Windows paths, ANSI colors, exact suffixes, and deduplicate", () => {
	const line = "\u001b[1mC:\\work\\src\\solution.cpp:12:7: \u001b[31merror: expected ';'\u001b[0m";
	assert.equal(parseCompilerDiagnostics(`${line}\r\n${line}`, "src/solution.cpp").length, 1);
	assert.equal(parseCompilerDiagnostics(line, "other/solution.cpp").length, 0);
	assert.equal(parseCompilerDiagnostics("solution.cpp:0:2: error: invalid position").length, 0);
	assert.equal(parseCompilerDiagnostics("solution.cppx:4:5: error: different extension").length, 0);
});

test("known exercise mistakes get precise ranges without modifying source", () => {
	const source = [
		"BorrowResult borrow_book(LibraryApi& library, const std::string& book_id) {",
		"    bool in_stock = borrow(book_id);",
		"    return in_stock ? BorrowResult(borrowed) : BorrowResult(not_found)",
		"}",
	].join("\n");
	const before = source;
	const diagnostics = diagnose(source);
	assert.equal(source, before);
	assert.equal(diagnostics.length, 4);
	assert.deepEqual(diagnostics.map(({ line, column, endColumn }) => ({ line, column, endColumn })), [
		{ line: 2, column: 21, endColumn: 27 },
		{ line: 3, column: 36, endColumn: 44 },
		{ line: 3, column: 61, endColumn: 70 },
		{ line: 3, column: 70, endColumn: 71 },
	]);
	assert.match(diagnostics[0]!.message, /library\.borrow/);
	assert.match(diagnostics[1]!.message, /BorrowResult::borrowed/);
	assert.match(diagnostics[2]!.message, /BorrowResult::not_found/);
	assert.match(diagnostics[3]!.message, /';'/);
});

test("qualified code and complete return statements have no speculative diagnostics", () => {
	assert.deepEqual(diagnose(`BorrowResult borrow_book(LibraryApi& library, const std::string& book_id) {
    bool success = library.borrow(book_id);
    return success ? BorrowResult::borrowed : BorrowResult::not_found;
}`), []);
	assert.deepEqual(diagnose("auto f() { return arbitrary_unknown_function(); }"), []);
	assert.deepEqual(diagnose("void f() { object.borrow(book_id); pointer->borrow(book_id); ns::borrow(book_id); }"), []);
});

test("comments, character literals, ordinary strings and raw strings are ignored", () => {
	assert.deepEqual(diagnose(`// borrow(book_id); return BorrowResult(borrowed)
/* borrowed not_found borrow(book_id) return x } */
auto message = "borrow(book_id) BorrowResult(not_found) return x }";
auto character = 'b';
auto raw = R"tag(borrow(book_id) " BorrowResult(borrowed) return x })tag";
auto unicode = u8R"(borrow(book_id) return x })";
auto number = 1'000;
BorrowResult f() { return BorrowResult::borrowed; }`), []);
	const afterComment = diagnose("/* borrow(book_id) */\n  borrow(book_id);");
	assert.equal(afterComment.length, 1);
	assert.equal(afterComment[0]!.line, 2);
	assert.equal(afterComment[0]!.column, 3);
});

test("declared free functions, locals, function pointers and enum values suppress name hints", () => {
	for (const source of [
		"bool borrow(const std::string&); void f() { borrow(book_id); }",
		"void f() { auto borrow = [](auto id) { return true; }; borrow(book_id); }",
		"void f() { bool (*borrow)(int); borrow(1); }",
		"void f() { int borrowed = 1; auto value = BorrowResult(borrowed); }",
		"enum Local { borrowed, not_found }; void f() { auto value = borrowed; }",
		"void f() { auto [borrowed, not_found] = values; auto value = borrowed; }",
		"using helpers::borrow; void f() { borrow(book_id); }",
		"using enum BorrowResult; auto f() { return borrowed; }",
		"using namespace helpers; void f() { borrow(book_id); auto value = borrowed; }",
	]) assert.deepEqual(diagnose(source), [], source);
});

test("preprocessor declarations and shadowed receivers avoid misleading suggestions", () => {
	assert.deepEqual(diagnose("#define borrow(id) other(id)\n#define borrowed 1\nvoid f() { borrow(book_id); auto x = borrowed; }"), []);
	assert.deepEqual(diagnose("void f(OtherApi& library) { borrow(book_id); }"), []);
	assert.deepEqual(diagnose("struct Derived : LibraryApi { void f() { borrow(book_id); } };"), []);
	assert.deepEqual(diagnose("#define RESULT 1;\nint f() { return RESULT\n}"), []);
});

test("missing return semicolons work across lines and skip incomplete expressions", () => {
	const multiline = diagnose("auto f() {\n return true\n     ? BorrowResult::borrowed\n     : BorrowResult::not_found\n}");
	assert.equal(multiline.length, 1);
	assert.equal(multiline[0]!.line, 4);
	assert.match(multiline[0]!.message, /';'/);
	assert.deepEqual(diagnose("auto f() { return (value\n}"), []);
	assert.deepEqual(diagnose("auto f() { return value;\n}"), []);
	assert.deepEqual(diagnose("auto f() { return []() { return 1; }(); }"), []);
});

test("the same diagnostics use independent API metadata rather than fixture-specific names", () => {
	const context: ExerciseCodeContext = {
		symbols: [], bindings: [{ name: "store", type: "StoreApi" }],
		types: [
			{ name: "StoreApi", access: "member", members: [{ name: "fetch", kind: "method", detail: "", documentation: "" }] },
			{ name: "Result", access: "scope", members: [{ name: "ready", kind: "constant", detail: "", documentation: "" }] },
		],
	};
	const diagnostics = findExerciseCodeDiagnostics("void f() { fetch(); auto state = ready; }", context);
	assert.equal(diagnostics.length, 2);
	assert.match(diagnostics[0]!.message, /store\.fetch/);
	assert.match(diagnostics[1]!.message, /Result::ready/);
});
