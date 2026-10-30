import type { CodeRunResult } from "./code-workspace.ts";

export const API_DEMO_VERSION = "library-v1";
export interface ApiDemoFile {
	path: string;
	role: "learner" | "api" | "support";
	description: string;
	source: string;
}
export interface ApiDemoRun {
	id: string;
	source: string;
	revision: string;
	status: "completed" | "compilation_error" | "runtime_error" | "timeout" | "unavailable";
	compiler: string;
	stdout: string;
	stderr: string;
	compilerStdout: string;
	compilerStderr: string;
	stdin: string;
	createdAt: string;
}
export interface ApiDemoWorkspace {
	source: string;
	revision: string;
	path: string;
	files: ApiDemoFile[];
	lastRun?: ApiDemoRun;
	lastCheck?: CodeRunResult;
}

export const API_DEMO_STARTER = `#include "library_api.hpp"

BorrowResult borrow_book(
    LibraryApi& library, const std::string& book_id
) {
    // Borrow one copy, or return the appropriate failure result.
    // The API reference describes the methods and exceptions.
    return BorrowResult::unavailable;
}
`;

export const API_DEMO_SCENARIOS = [
	{ id: "available", label: "Two copies available", stdin: "dune 2 1\n" },
	{ id: "last-copy", label: "Last copy", stdin: "dune 1 1\n" },
	{ id: "unavailable", label: "No copies available", stdin: "dune 0 1\n" },
	{ id: "not-found", label: "Unknown book", stdin: "unknown 2 1\n" },
	{ id: "offline", label: "Service offline", stdin: "dune 2 0\n" },
];

export const API_DEMO_TESTS = [
	{ name: "Borrows one of two copies", stdin: "dune 2 1\n", expectedStdout: "result: borrowed\nloans: 1\navailable: 1\n" },
	{ name: "Borrows the last copy", stdin: "dune 1 1\n", expectedStdout: "result: borrowed\nloans: 1\navailable: 0\n" },
	{ name: "Leaves an unavailable book unchanged", stdin: "dune 0 1\n", expectedStdout: "result: unavailable\nloans: 0\navailable: 0\n" },
	{ name: "Handles an unknown book", stdin: "unknown 2 1\n", expectedStdout: "result: not_found\nloans: 0\navailable: 2\n" },
	{ name: "Handles an offline service", stdin: "dune 2 0\n", expectedStdout: "result: offline\nloans: 0\navailable: 2\n" },
];

export const API_DEMO_FILES: ApiDemoFile[] = [
	{ path: "solution.cpp", role: "learner", description: "Your function. This is the only file you need to edit.", source: API_DEMO_STARTER },
	{ path: "library_api.hpp", role: "api", description: "The public API: types, method signatures, and behavior.", source: `#pragma once
#include <optional>
#include <stdexcept>
#include <string>

enum class BorrowResult { borrowed, unavailable, not_found, offline };

struct Book {
    std::string id;
    std::string title;
    int available_copies;
};

class ServiceUnavailable : public std::runtime_error {
public:
    ServiceUnavailable() : std::runtime_error("Library service is offline") {}
};

// A local simulation, not a connection to a real library service.
class LibraryApi {
public:
    LibraryApi(int available_copies, bool online);

    // Returns a book or std::nullopt. Throws ServiceUnavailable when offline.
    std::optional<Book> find_book(const std::string& book_id);

    // Borrows one copy and returns true; returns false for an unknown book
    // or no stock. Throws ServiceUnavailable when offline.
    bool borrow(const std::string& book_id);

    // Observation helpers used by the supplied driver.
    int loan_count() const;
    int remaining_copies() const;

private:
    int copies_;
    int loans_ = 0;
    bool online_;
    void require_online() const;
};

BorrowResult borrow_book(LibraryApi& library, const std::string& book_id);
` },
	{ path: "library_api.cpp", role: "support", description: "The simulated service. Each process starts with fresh stock; calls are logged to stderr.", source: `#include "library_api.hpp"
#include <iostream>

LibraryApi::LibraryApi(int available_copies, bool online)
    : copies_(available_copies), online_(online) {}

void LibraryApi::require_online() const {
    if (!online_) {
        std::cerr << "service -> offline\\n";
        throw ServiceUnavailable();
    }
}

std::optional<Book> LibraryApi::find_book(const std::string& book_id) {
    require_online();
    if (book_id != "dune") {
        std::cerr << "find_book(\\\"" << book_id << "\\\") -> not found\\n";
        return std::nullopt;
    }
    std::cerr << "find_book(\\\"dune\\\") -> found, copies=" << copies_ << '\\n';
    return Book{"dune", "Dune", copies_};
}

bool LibraryApi::borrow(const std::string& book_id) {
    require_online();
    if (book_id != "dune" || copies_ == 0) {
        std::cerr << "borrow(\\\"" << book_id << "\\\") -> false\\n";
        return false;
    }
    --copies_;
    ++loans_;
    std::cerr << "borrow(\\\"dune\\\") -> true, copies=" << copies_ << '\\n';
    return true;
}

int LibraryApi::loan_count() const { return loans_; }
int LibraryApi::remaining_copies() const { return copies_; }
` },
	{ path: "main.cpp", role: "support", description: "Reads your chosen input, calls your function, and reports the result and resulting state.", source: `#include "library_api.hpp"
#include <iostream>

const char* result_name(BorrowResult result) {
    switch (result) {
        case BorrowResult::borrowed: return "borrowed";
        case BorrowResult::unavailable: return "unavailable";
        case BorrowResult::not_found: return "not_found";
        case BorrowResult::offline: return "offline";
    }
    return "unknown";
}

int main() {
    std::string book_id;
    int copies, online;
    if (!(std::cin >> book_id >> copies >> online) || copies < 0 || copies > 10 || (online != 0 && online != 1)) {
        std::cerr << "Input: book_id copies(0..10) online(0 or 1)\\n";
        return 2;
    }
    LibraryApi library(copies, online == 1);
    BorrowResult result = borrow_book(library, book_id);
    std::cout << "result: " << result_name(result) << '\\n'
              << "loans: " << library.loan_count() << '\\n'
              << "available: " << library.remaining_copies() << '\\n';
}
` },
	{ path: "CMakeLists.txt", role: "support", description: "Builds the same three C++ files outside LearnHarness.", source: `cmake_minimum_required(VERSION 3.16)
project(library_exercise LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
add_executable(library_exercise solution.cpp library_api.cpp main.cpp)
target_include_directories(library_exercise PRIVATE ".")
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(library_exercise PRIVATE -Wall -Wextra -pedantic -O0)
endif()
` },
	{ path: "compile_flags.txt", role: "support", description: "C++20 and local headers for editor completion.", source: "-std=c++20\n-I.\n-Wall\n-Wextra\n-pedantic\n" },
	{ path: "README.md", role: "support", description: "Instructions for running this project independently.", source: `# Library API practice

This project uses a local simulated library service. It does not contact a real service or create real loans. Each execution starts with fresh state.

Edit solution.cpp. API declarations and behavior are in library_api.hpp. Keep the supporting files unchanged when checking the exercise in LearnHarness.

Build with Clang (or substitute g++):

    clang++ -std=c++20 -Wall -Wextra -pedantic -O0 -I. solution.cpp library_api.cpp main.cpp -o library_exercise
    echo "dune 2 1" | ./library_exercise

Or use CMake:

    cmake -S . -B build
    cmake --build build
    echo "dune 2 1" | ./build/library_exercise

Input: book ID, copies (0..10), online (1 or 0). The only known book ID is dune. Output reports the returned result, loan count, and remaining copies. stderr contains API calls and any errors. Passing fixture tests is not proof of integration with a real library service.
` },
];
