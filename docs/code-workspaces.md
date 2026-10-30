# Code answers and runnable exercises

Use **Write code** in a conversation, free-text answer, or practice thinking field for a code editor with C++ syntax highlighting, line numbers, indentation, bracket matching, undo, word completion, and Vim keybindings. Editors start in Normal mode: use `h/j/k/l` to move, `i` to insert, `Esc` or `Ctrl+[` to return to Normal, `v` for Visual mode, `u` to undo, and `/` to search. The status bar shows the current mode. In Insert mode, Enter inserts a newline and Tab indents; Cmd/Ctrl+Enter sends or checks in either mode. Escape stays in the editor without dismissing the answer or stopping the session. Code answers are saved as Markdown fences and typeset in the transcript. Text mode retains the existing prose and file-path editing behavior.

## Try the C++ demo

Run `npm run dev`, then open `/code-demo`, or follow **Try C++ checks** from a code input. No model connection is needed for this demo. Complete `add(a, b)` in the generated `solution.cpp`. The initial file has the includes, function signature, input handling, and entry point already supplied. It compiles, but three of four tests fail until the function is implemented.

**Check** saves an edited in-app draft, then compiles and tests the saved source. Results distinguish compilation errors, runtime failures, timeouts, failed assertions against expected output, and passing tests. Tests compare standard output, normalizing CRLF and final newlines only. Compiler success alone never means the answer is correct.

**Open in editor** opens the real workspace file in VS Code, Cursor, or the system text editor. The workspace also contains `compile_flags.txt` for C++20-aware tools such as clangd. Rich autocomplete in an external editor comes from that editor's installed C++ extension. Save there, then choose **Reload saved file** or **Check** in LearnHarness. If both editors have changed the file, LearnHarness preserves the in-app draft and offers an explicit choice before replacement.

## API exercise demo

Open `/code-demo/api` for a multi-file C++ example. Implement `borrow_book` against a **simulated library API**. The editor focuses on `solution.cpp`; the API reference and supporting files remain inspectable. The simulation never contacts a real service or creates a real loan. Clang/GCC still compiles and executes the learner's actual saved code, linked with the supplied API implementation and driver.

**Run** executes a selected scenario or custom standard input without grading it. Input is `book_id copies online`, for example `dune 2 1`; copies must be 0–10 and online must be 0 or 1. Each process starts with fresh state. Standard output shows the function's return value and resulting loan/stock counts; standard error includes API activity and runtime diagnostics. **Check exercise** runs five fixed cases, checking both the return value and the resulting state. Successful execution alone is not a passing check, and passing simulated cases does not establish integration with a real library.

**Open in editor** opens the complete local project. The generated `README.md`, `CMakeLists.txt`, and `compile_flags.txt` support building and editing independently. Save external changes to `solution.cpp`, then reload, run, or check in the demo. Supporting files are fixed for this exercise; changing them is reported instead of silently replacing them. This demo is separate from model-authored practice exercises, whose schema still supports one complete source file.

## Coding practice

The practice agent can attach optional `codeExercise` data to a problem:

```json
{
  "language": "cpp",
  "starterCode": "...complete C++20 program with an unfinished function...",
  "tests": [
    { "name": "Example", "stdin": "2 3\n", "expectedStdout": "5\n" }
  ]
}
```

The committed model solution remains separate from the learner's starter. The agent is instructed to supply compilable boilerplate and meaningful tests, although generated starter code can still contain errors; the real compiler reports those errors. **Check & submit** sends a stored check ID. The server resolves it into the actual source and compiler/test evidence, validates that the exercise is still active and the source has not changed, and persists that snapshot in the conversation for the tutor and transcript. Client-supplied verdicts are ignored. Failed attempts can be submitted for help.

## Local execution

This first version runs trusted local exercises on the same computer as LearnHarness. It requires `clang++` or `g++` on PATH (Xcode Command Line Tools on macOS). No compiler or editor is downloaded automatically. Code runs with the OS user's permissions; this is not a sandbox for untrusted code or a public code-grading service. Environment variables containing provider credentials are not inherited. The API requires loopback and same-origin requests, with the existing desktop capability check when applicable. Generated exercise metadata cannot supply shell commands.

Source is limited to 64 KiB, exercises to 12 tests, each test input/expected output to 8 KiB, and process output to 64 KiB. Compilation and tests have time limits; concurrent checks are capped. Temporary build directories are cleaned after checks. Source, editor flags, and check snapshots persist beneath `PATHS.data/code-workspaces`, including the desktop's writable user-data directory. Opening workspaces does not grant the agent general file-writing tools.

## Adding languages

The exercise, workspace, revision, test, submission, and UI contracts are language-independent. Only C++ checking is enabled today. Add a language adapter in `src/server/code-runner.ts` with a filename, toolchain candidates, optional compilation step, and execution command builder. Interpreted languages can omit compilation and provide a runtime probe. Add the accepted language to `parseCodeExercise`, its editor syntax extension in `components/code-editor.tsx`, and authoring instructions. Neither learner nor model supplies arbitrary execution commands. Add compiler/runtime error, timeout, incorrect-answer, and successful-answer fixtures for each adapter.

Verification covers actual C++ compilation and execution, stale external edits, changed exercises, path escapes, request authorization, server-owned submission evidence, and existing answer-input behavior. Local compiler tests skip when no C++ compiler is available.
