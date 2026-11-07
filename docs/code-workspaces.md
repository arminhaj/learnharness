# Coding workspace and runnable exercises

Open **Coding** from the sidebar and describe what you want to learn. Choose **Problem** for a focused algorithm exercise or **Project** to implement one feature in a small runnable project. Choose a language and select **Generate workspace**. Generation uses your configured strong model and saves the workspace under **Recent workspaces**.

For a project based on an existing codebase, select the relevant text files as context. LearnHarness sends those files to your configured model and builds a separate exercise. Review the generated source and supporting files before running the checks. The exercise identifies simulated APIs or services.

In a Teaching session, open **The plan → Coding exercises** and choose a step. Use **Generate exercise** to create its workspace. Returning to the same step opens your saved workspace. **Choose another step** lets you start an exercise from a step outside the suggested list.

**Examples** contains prepared exercises grouped by language. They work without a model connection. Save edits before switching workspaces to keep working from the saved file when you return.

Editors start in Vim Normal mode: use `h/j/k/l` to move, `i` to insert, `Esc` or `Ctrl+[` to return to Normal, `v` for Visual mode, `u` to undo, and `/` to search. The status bar shows the current mode. In Insert mode, Enter inserts a newline and Tab indents. Cmd/Ctrl+Enter checks the exercise.

## Supported languages

| Language | Profile | Requirement | Entry point | Supporting files |
| --- | --- | --- | --- | --- |
| C++20 (`cpp`; aliases `c++`, `cxx`) | `cpp20-stdio` | `clang++` or `g++` on PATH | `solution.cpp` | flat `.cpp`, `.h`, `.hpp` |
| Python 3.11+ (`python`; aliases `py`, `python3`) | `python3-stdio` | Python 3.11 or newer on PATH | `solution.py` | relative `.py` module paths, including packages such as `pkg/util.py` |

Rust is recognized by name but has no executable profile, so it cannot be selected or checked. Both profiles use the same exercise shape (one editable source, optional supporting files, standard-input/standard-output tests), the same limits, and the same assessment: expected output is compared after normalizing CRLF and final newlines only.

Whether this computer can run a profile right now is shown as a note on the workspace pages ("Python 3.11 or newer was not found…"). It never blocks opening, editing, saving, or generating: a saved Python exercise reopens and stays editable without an interpreter, and only **Check** reports the missing requirement.

## Add two integers

Choose **Add two integers** under **C++20** (the Python version, under **Python 3.11+**, is the same exercise in `solution.py`). Complete `add(a, b)` in the generated `solution.cpp`. The initial file has the includes, function signature, input handling, and entry point already supplied. It compiles, but three of four tests fail until the function is implemented.

**Check** saves an edited in-app draft, then compiles and tests the saved source. Results distinguish compilation errors, runtime failures, timeouts, failed assertions against expected output, and passing tests. Tests compare standard output, normalizing CRLF and final newlines only. Compiler success alone never means the answer is correct.

**Open in editor** opens the real workspace file in VS Code, Cursor, or the system text editor. A C++ workspace also contains `compile_flags.txt` for C++20-aware tools (Python workspaces have no equivalent file) such as clangd. Rich autocomplete in an external editor comes from that editor's installed C++ extension. Save there, then choose **Reload saved file** or **Check** in LearnHarness. If both editors have changed the file, LearnHarness preserves the in-app draft and offers an explicit choice before replacement.

## Python

**Discovery.** LearnHarness tries `python3`, then `python` (and, on Windows, `py -3`), and verifies the interpreter's actual version. A missing launcher, a stub that does not report a version, or a Python older than 3.11 is skipped, so an old system `python3` falls through to a newer `python` later on PATH. If none qualifies, the check reports that Python 3.11+ is required (naming an older version it found) and nothing is installed or configured for you.

**Syntax check, then run.** Every check first validates the syntax of `solution.py` and every supporting `.py` module with a trusted helper that compiles the source without executing it and writes no bytecode. The helper runs in isolated mode, so even a supporting module named like a standard-library module cannot be imported or run during validation. A syntax problem is reported as a *syntax check failure* (not a compilation error), with the file, line, and, when Python supplies one, the column. Support-file errors are attributed to that file and never underlined in your solution.

**Execution.** Each test runs in a fresh process, in a private temporary copy of the workspace, as `python -E -S -B -u -X utf8 solution.py`: Python environment variables are ignored, `site` is skipped (standard library only; no packages are installed), no bytecode is written, output is unbuffered, and UTF-8 is used for input and output. The script directory stays on the import path so local modules work. This is interpreter configuration, not a sandbox.

**Diagnostics.** A runtime exception shows its traceback. Frames that fall in the workspace's own files become line diagnostics on the file that raised the error; frames in the standard library or elsewhere are ignored. A traceback gives no reliable column, so those diagnostics mark the line rather than a token.

## API exercise demo

Open `/code-demo/api` for a multi-file C++ example. Implement `borrow_book` against a **simulated library API**. The editor focuses on `solution.cpp`; the API reference and supporting files remain inspectable. The simulation never contacts a real service or creates a real loan. Clang/GCC still compiles and executes the learner's actual saved code, linked with the supplied API implementation and driver.

**Run** executes a selected scenario or custom standard input without grading it. Input is `book_id copies online`, for example `dune 2 1`; copies must be 0–10 and online must be 0 or 1. Each process starts with fresh state. Standard output shows the function's return value and resulting loan/stock counts; standard error includes API activity and runtime diagnostics. **Check exercise** runs five fixed cases, checking both the return value and the resulting state. Successful execution alone is not a passing check, and passing simulated cases does not establish integration with a real library.

**Open in editor** opens the complete local project. The generated `README.md`, `CMakeLists.txt`, and `compile_flags.txt` support building and editing independently. Save external changes to `solution.cpp`, then reload, run, or check in the demo. Supporting files are fixed for this exercise; changing them is reported instead of silently replacing them. This demo is separate from model-authored practice exercises, whose schema still supports one complete source file.

## Coding in Teaching

When a Teaching task asks the learner to write, complete, modify, or debug code in a supported language, the tutor is instructed to use a free-response `ask_user_question` with `codeExercise`. It automatically opens a wider coding workspace in the same session, with the problem and learner reasoning beside the editor on larger screens. **Read lesson** collapses it without discarding the editor draft; **Return to code** reopens it. The lesson plan remains accessible. Conceptual questions about code continue to use the ordinary question format.

Supply the problem as `question`, the exercise as `codeExercise`, and the current plan step as `nodeId` when applicable; omit `options` and `multiSelect`. Teaching validates the node against the live plan, and coding calls advance lesson position without automatically completing a step. **Check** builds (or syntax-checks) and runs the supplied tests without sending an answer. **Check & submit** sends the saved source and server-owned build/test results back to the same tutor. A failing check can also be submitted for help. Passing the supplied tests does not automatically mark a Teaching answer correct or prove concurrency properties. When another attempt is needed, the tutor seeds its next coding question from the submitted source.

Existing text questions are not retroactively converted. The tutor uses the coding route on subsequent turns. A plan step may name its language by alias (`py`, `python3`, `c++`); a step in a language without an executable profile keeps the lesson conceptual. The prompts' executable-language section is generated from the same catalog the validators use. Native plan-linked questions are checked like the manual route: a step with an explicit language only accepts an exercise in that language (aliases allowed).

The workspace offers the same saved-file reload, external-editor opening, draft conflict protection, and stale-result checks as Practice. A question that has been answered or dismissed can no longer accept a check. Resuming an unanswered question restores its saved code; a later question gets its own workspace, including when a provider reuses a call ID.

Course packets may contain a `teaching-question.json` with `{ "question": "...", "codeExercise": { ... } }`. This is authoring data for the tutor to read and pass to `ask_user_question`, not a file-import format. The tutor reads the chosen topic's packet and exercise through its existing file tools. Packet creation itself does not start a session.

## Coding in Practice

The practice agent can attach optional `codeExercise` data to a problem:

```json
{
  "language": "python",
  "starterCode": "...complete program with an unfinished function...",
  "tests": [
    { "name": "Example", "stdin": "2 3\n", "expectedStdout": "5\n" }
  ]
}
```

The committed model solution remains separate from the learner's starter. The agent is instructed to supply runnable boilerplate and meaningful tests, although generated starter code can still contain errors; the real compiler or syntax check reports those errors. **Check & submit** sends a stored check ID. The server resolves it into the actual source and compiler/test evidence, validates that the exercise is still active and the source has not changed, and persists that snapshot in the conversation for the tutor and transcript. Client-supplied verdicts are ignored. Failed attempts can be submitted for help.

## Local execution

This version runs trusted local exercises on the same computer as LearnHarness. C++20 needs `clang++` or `g++` on PATH (Xcode Command Line Tools on macOS); Python needs Python 3.11 or newer. No compiler, interpreter, package, or editor is downloaded or installed automatically. Code runs with the OS user's permissions; this is not a sandbox for untrusted code or a public code-grading service. Environment variables containing provider credentials are not inherited. The API requires loopback and same-origin requests, with the existing desktop capability check when applicable. Generated exercise metadata cannot supply shell commands.

Source is limited to 64 KiB, exercises to 12 tests, each test input/expected output to 8 KiB, and process output to 64 KiB. Builds, syntax checks, and tests have time limits; concurrent checks are capped. Temporary build directories are cleaned after checks. Source, editor flags, and check snapshots persist beneath `PATHS.data/code-workspaces`, including the desktop's writable user-data directory. Opening workspaces does not grant the agent general file-writing tools.

## Evidence and persistence

A check is saved as a legacy-compatible result (`status`, `compiler`, per-test results) plus an optional versioned `detail`: the execution snapshot ID, toolchain, per-phase outputs (preparation/build and one execution per test), structured diagnostics, and the stdio assessment. Run completion and assessment are independent: a successful run is never turned into a failed check. Python syntax failures use the language-neutral `preparation_error` status.

The snapshot ID digests the ordered execution inputs: every resource's path, role, and content, the program target, the effective ordered build-source selection, the check cases, and the profile ID and version. Submission recomputes it from the workspace as it is now and rejects new evidence that no longer matches; older saved results without `detail` keep their original source/exercise/ownership validation. Workspace identity (the hash of the original exercise and supporting files) and the source-only edit revision are separate and unchanged.

Supporting files may live in subdirectories (Python), and a Python supporting source keeps its exact bytes and may be empty (for example a package `__init__.py`); C++ supporting sources remain nonempty and trimmed as before. Every existing component of a workspace path is checked with `lstat` when it is created, read, and verified, so a symlink anywhere in the path (not only at the final file) is refused. Saved check records are bounded by a limit derived from the output limits, and an oversized record is refused before it is published.

## Adding languages

Languages are added by registration, not by branching in generic persistence, assessment, or submission code:

1. **Catalog** (`src/core/code-language-catalog.ts`): a language descriptor (canonical ID, aliases, editor capabilities) and a profile descriptor (ID, version, entry filename, supporting-file extensions and path style, authoring fragments, labels). A language without a profile is recognized but cannot execute.
2. **Provider** (`src/server/*-provider.ts`, registered in `src/server/code-providers.ts`): readiness, fixed-argv build/preparation, build-source selection, optional scaffolding, and optional execution diagnostics. Neither learner nor model supplies commands, executable paths, or arguments.
3. **Editor** (`components/code-editor.tsx`): a syntax provider keyed by the catalog's `editor.syntax`. Plain editing is the fallback, and completion/hints run only for languages that advertise them.

Authoring schemas, generation instructions, and tool wording are composed from the catalog; the Teaching and Practice prompts end with a section generated from the catalog's executable profiles, so editable prompt prose and overrides never restate the language list. Add timeout, cancellation, output-limit, build/syntax-failure, incorrect-answer, and successful-answer fixtures for each provider.

Verification covers actual C++ and Python execution, stale external edits, changed exercises, path escapes, request authorization, server-owned submission evidence, and existing answer-input behavior. Runtime tests skip, and say so, when no suitable compiler or Python 3.11+ interpreter is available.
