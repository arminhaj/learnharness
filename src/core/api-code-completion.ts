import type { ExerciseCodeContext, ExerciseCodeSymbol } from "./code-completion.ts";

const libraryMethods: readonly ExerciseCodeSymbol[] = [
	{
		name: "find_book", kind: "method", detail: "(const std::string& book_id) → std::optional<Book>",
		documentation: "Looks up a book without creating a loan. Returns std::nullopt for an unknown ID. Throws ServiceUnavailable when the service is offline.",
		insertText: "find_book(book_id)", resultType: "std::optional<Book>",
	},
	{
		name: "borrow", kind: "method", detail: "(const std::string& book_id) → bool",
		documentation: "Borrows one copy and creates one loan on success. Returns false for either an unknown book or no stock; false does not distinguish those cases. Throws ServiceUnavailable when offline.",
		insertText: "borrow(book_id)", resultType: "bool",
	},
	{
		name: "loan_count", kind: "method", detail: "() const → int",
		documentation: "Returns the number of loans created in this run. Does not change the library.",
		insertText: "loan_count()", resultType: "int",
	},
	{
		name: "remaining_copies", kind: "method", detail: "() const → int",
		documentation: "Returns the number of copies remaining in this run. Does not change the library.",
		insertText: "remaining_copies()", resultType: "int",
	},
];

const borrowResults: readonly ExerciseCodeSymbol[] = [
	{ name: "borrowed", kind: "constant", detail: "BorrowResult", documentation: "A loan was created.", resultType: "BorrowResult" },
	{ name: "unavailable", kind: "constant", detail: "BorrowResult", documentation: "No copy can be borrowed.", resultType: "BorrowResult" },
	{ name: "not_found", kind: "constant", detail: "BorrowResult", documentation: "The requested book does not exist.", resultType: "BorrowResult" },
	{ name: "offline", kind: "constant", detail: "BorrowResult", documentation: "The library service cannot respond.", resultType: "BorrowResult" },
];

const standardSymbols: readonly ExerciseCodeSymbol[] = [
	{ name: "optional", kind: "type", detail: "std::optional<Book>", documentation: "A value that may contain a Book. Check for a value before reading its fields.", insertText: "optional<Book>" },
	{ name: "string", kind: "type", detail: "std::string", documentation: "The string type used for book IDs and titles." },
	{ name: "nullopt", kind: "constant", detail: "std::nullopt_t", documentation: "Represents an empty optional, such as an unknown book returned by find_book." },
];

/** Editor reference only. Kept separate from the files that identify a saved workspace. */
export const API_DEMO_CODE_CONTEXT: ExerciseCodeContext = {
	symbols: [
		{ name: "LibraryApi", kind: "class", detail: "class LibraryApi", documentation: "The supplied library simulator. Call its methods through the library parameter." },
		{ name: "Book", kind: "type", detail: "struct Book", documentation: "A book snapshot with id, title, and available_copies fields. Editing this value does not create a loan." },
		{ name: "BorrowResult", kind: "enum", detail: "enum class BorrowResult", documentation: "The function's return type. Use a scoped value such as BorrowResult::borrowed, not BorrowResult(borrowed)." },
		{ name: "ServiceUnavailable", kind: "class", detail: "class ServiceUnavailable : std::runtime_error", documentation: "Exception thrown by find_book and borrow when the service is offline." },
		{ name: "library", kind: "variable", detail: "LibraryApi&", documentation: "The simulator passed to your function. Call library.find_book(book_id) or library.borrow(book_id).", resultType: "LibraryApi" },
		{ name: "book_id", kind: "variable", detail: "const std::string&", documentation: "The requested book ID passed to your function.", resultType: "std::string" },
		...libraryMethods.map(symbol => ({ ...symbol, name: `library.${symbol.name}`, insertText: `library.${symbol.insertText ?? symbol.name}` })),
		...borrowResults.map(symbol => ({ ...symbol, name: `BorrowResult::${symbol.name}`, insertText: `BorrowResult::${symbol.name}` })),
		{ name: "std", kind: "namespace", detail: "namespace std", documentation: "Standard library types used by the supplied header." },
		...standardSymbols.map(symbol => ({ ...symbol, name: `std::${symbol.name}`, insertText: `std::${symbol.insertText ?? symbol.name}` })),
	],
	bindings: [
		{ name: "library", type: "LibraryApi" },
		{ name: "book_id", type: "std::string" },
	],
	types: [
		{ name: "LibraryApi", access: "member", members: libraryMethods },
		{
			name: "Book", access: "member", members: [
				{ name: "id", kind: "property", detail: "std::string", documentation: "This book's ID.", resultType: "std::string" },
				{ name: "title", kind: "property", detail: "std::string", documentation: "This book's title.", resultType: "std::string" },
				{ name: "available_copies", kind: "property", detail: "int", documentation: "Available copies at the time the book was looked up. This snapshot does not update when a copy is borrowed.", resultType: "int" },
			],
		},
		{ name: "BorrowResult", access: "scope", members: borrowResults },
		{
			name: "std::optional<Book>", access: "member", members: [
				{ name: "has_value", kind: "method", detail: "() const → bool", documentation: "Returns whether this optional contains a book.", insertText: "has_value()", resultType: "bool" },
				{ name: "value", kind: "method", detail: "() → Book&", documentation: "Returns the contained book. Throws std::bad_optional_access if empty; check for a value first.", insertText: "value()", resultType: "Book" },
			],
		},
		{ name: "std", access: "scope", members: standardSymbols },
	],
};
