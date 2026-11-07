# Coding workspace language generalization handoff

All three milestones were implemented through Claude Code and accepted after review on November 6, 2026. Checkpoints: shared contracts/catalog `0bd1b15`, C++ migration `b193cf9`, Python `eeb271e`. See [the implementation review](coding-workspace-language-review.md) for validation results and remaining full-suite issues. The specification below records the approved implementation handoff.

## Objective and approved scope

Implement the language generalization plan in LearnHarness Fork, in the existing `all-features-preview` checkout on branch `codex/all-features-preview`. The user has authorized implementation through the installed Claude Code CLI using its existing authentication. Claude performs implementation; Codex reviews each milestone and its tests before authorizing the next milestone. This handoff makes the previously discussed plan concrete and supplies the implementation decisions for those milestones.

The preview's pre-existing changes were checkpointed and pushed to `origin/codex/all-features-preview` as `9855b78133e1c75cb8a27585fb1c74f59d6041a5`. Preserve that work. Do not reset, rewrite history, change credentials, or modify installed application releases or user data. The task concerns the repository checkout; deployment is separate.

Implement three milestones, in order:

1. Shared contracts and capability catalog, preserving current behavior.
2. C++ migration to providers, execution evidence, and separate assessment, with existing feature parity.
3. Python execution and integration across Coding, Teaching, and Practice.

Stop after each milestone. Report the diff, commands and exact test outcomes, remaining limitations, and any uncertainty to Codex. Do not continue into the next milestone until Codex supplies the review result. Do not commit or push implementation changes yourself; Codex owns reviewed checkpoints.

Read `AGENTS.md` before editing. The user has approved the plan and requested execution, so no additional approval is needed for the decisions specified here. For a material decision not resolved here, report it to Codex. Read the relevant installed Next.js guide before changing framework code, as required by `AGENTS.md`.

## Architectural boundaries

The initial interaction remains one editable source resource plus optional supporting resources, one finite program target, and standard-input/standard-output checks. Use resource collections, profile IDs, and typed evidence as extension seams. Do not implement multi-file editing, a native-test-suite profile, notebooks, REPLs, language servers, debuggers, containers, package installation, or remote execution in this task. Keep the prepared API demo's exercise authoring C++ specific while preserving its behavior through the common runner.

Distinguish these identities:

- A language identifies source syntax, such as `cpp` or `python`.
- An execution profile identifies a supported workflow, initially `cpp20-stdio` and later `python3-stdio`.
- A registered capability describes what this build implements.
- Runtime readiness describes whether this server can execute that profile now.
- A workspace ID identifies persisted learner work.
- A source revision protects draft conflicts and stale checks.
- An execution snapshot identifies the actual resources, check specification, and profile version used for new execution evidence.

Core/shared modules must remain browser safe. They may contain serializable types, descriptors, schemas, and pure validation/normalization. They must not import Node APIs, server modules, process handles, runtime probes, filesystem discovery, or editor packages. Trusted server providers own executable selection, argument construction, scaffolding, and diagnostic extraction. Editor providers own CodeMirror extensions and C++-specific assistance.

Model-authored exercise data and HTTP requests must never supply executable paths, shell commands, build scripts, or arbitrary process arguments. Reuse the current fixed-argument process execution and request authorization boundaries. This remains the existing trusted-local execution model, without claiming isolation from the operating system.

## Compatibility requirements

Keep today's unversioned authoring/persistence shape readable and writable for this milestone:

```ts
{ language, starterCode, tests: [{ name, stdin, expectedStdout }] }
```

Keep C++ aliases canonicalized to `cpp`. Python's canonical ID is `python`, with `py` and `python3` accepted as input aliases once milestone 3 is enabled. Never mutate historical transcript entries to insert inferred defaults.

The current workspace ID hashes `JSON.stringify(parseCodeExercise(setup))`, or `JSON.stringify({ exercise, supportFiles })` when support files are nonempty, and combines that hash with chat ID, full tool-call ID, and optional occurrence key. Preserve this exact identity projection for existing C++ data, including property order, test/support-file order, and original source bytes. Normalize only after computing legacy identity; do not spread new fields into legacy parser output before hashing.

Preserve existing workspace directories, filenames, metadata, `lastRunId`, `<runId>.json`, complete compound call IDs, occurrence handling, and exact-source SHA-256 revisions. Existing saved runs must remain readable without new required fields. New evidence can be attached as an optional versioned detail envelope; keep the existing `CodeRunResult` facade and old status meanings readable. For Python preparation failure, a new language-neutral `preparation_error` summary is allowed; render a meaningful syntax-error detail without calling it compilation.

For new results, attach a snapshot digest covering ordered execution inputs: relevant resource paths/content, target, check definitions, profile ID, and profile version. Keep this digest separate from workspace identity and source-only edit revisions. Use it to reject newly generated stale evidence. Continue validating historical results under their established legacy source/exercise/ownership rules.

Never filter saved-session parsing by installed-toolchain availability. A saved exercise must open and remain editable when its runtime is missing. Implemented profiles remain visible with an explanatory readiness state; generation/editing remain available, and execution reports missing requirements. Unimplemented languages must not advertise executable support.

Keep opaque server-owned `codeRunId` resolution and final synchronous revalidation after asynchronous work. Ignore client-supplied verdicts and source snapshots. A failed check remains submittable for help; supplied tests passing does not automatically complete a lesson node.

## Milestone 1 Shared contracts and capability catalog

### Deliverables

Add shared types in small modules under `src/core` and/or `src/core/contracts`. Concrete exported names may follow adjacent repository naming conventions; retain these responsibilities:

- `CodeActivitySpec`: internal `schemaVersion: 2`, profile ID/version, resource collection, program target with entry resource ID, and a discriminated `stdio` check specification.
- `CodeResource`: stable ID, validated relative path, optional language ID for non-source resources, source content, role (`learner` or `support` initially), and editability. Initially enforce exactly one editable learner source for implemented profiles.
- `ExecutionEvidence`: execution snapshot ID, toolchain identity/version when known, optional preparation/build/execution phases, preserved outputs, and structured diagnostics.
- `AssessmentResult`: check-case results and verdict, including not-run when execution fails before assessment.
- `CodeDiagnostic`: resource ID/path, optional trustworthy line/column range, severity, message, and source. Do not require invented locations.
- A pure normalizer from legacy exercise plus supporting files to the internal activity spec.

Add a pure capability/profile catalog with canonical language IDs, aliases, labels, filenames/conventions, implemented profile IDs, check kinds, and editor capability metadata. Register only executable C++ support at this milestone. Rust must not become executable because an authoring branch or filename exists. Python descriptors may be introduced only if clearly unimplemented and cannot pass executable validation yet.

Define the server provider boundary and a serializable readiness view separately from descriptors. Do not probe tools during shared imports or schema construction. Replace filename-sentinel support discovery with explicit registered-profile lookup while preserving the currently offered C++ experience.

Centralize the shared exercise authoring schema consumed by Teaching's `askInputSchema`, Practice's `problemInputObject`, and the parser. Keep authoring wording composable with profile instructions; keep byte-based bounds in runtime validation even when JSON schema uses string lengths. Preserve the legacy parsed shape and C++ behavior.

### Primary files to inspect

- `src/core/code-workspace.ts`, `src/core/coding-session.ts`, `src/core/question-core.ts`, `src/core/index.ts`
- `src/agent/tools/practice.ts`, `src/agent/tools.ts`
- `src/server/coding-sessions.ts`, `src/server/code-workspaces.ts`

### Acceptance

- Shared modules import from client code without server/runtime dependencies.
- Parser, Teaching schema, Practice schema, and catalog agree on executable profiles.
- Unknown and unimplemented profiles fail closed; runtime readiness does not control saved-content parsing.
- A compatibility fixture with pre-existing metadata, learner-edited source, saved run JSON, and `lastRunId` reopens with exactly the old workspace/check identity and resolves for submission.
- Existing C++ runner, workspace, Teaching, and Practice behavior remains unchanged.

## Milestone 2 C++ provider and shared execution migration

### Deliverables

Extract C++ setup, compiler discovery/selection, fixed argv construction, supporting-source selection, compile-flags scaffolding, and compiler diagnostics into a trusted C++ provider. Preserve current C++20 options, `clang++`/`g++` selection, flags-file contents, and never overwrite existing saved scaffolding or learner source.

Refactor common orchestration to resolve a normalized snapshot, perform optional preparation/build, execute the target, collect evidence, and then invoke the `stdio` assessor. The assessor retains the existing CRLF/final-newline normalization and interior-whitespace comparison. Ordinary Run consumes execution results directly rather than fabricating an expected-output test and translating a failed assessment back to successful execution.

Use the new normalizer and evidence boundary in the runner. Preserve the public legacy result facade for callers/historical runs, with optional new evidence. Preserve limits, concurrency, cancellation, process cleanup, path checks, same-origin/desktop authorization, workspace ownership, and final submission revalidation. Use execution snapshot validation for new evidence.

Consume catalog metadata consistently in workspace selection and generation. Compose common generation instructions with the selected implemented profile's instructions; remove authoring claims for unsupported Rust/Cargo execution. Move generic result rendering to phase-aware labels, retaining C++ labels for actual compilation. Consume normalized diagnostics by resource and revision rather than always applying the Clang/GCC parser in generic UI. Keep C++ completion/hints behind their language provider and preserve plain editing fallback.

Ensure Teaching and Practice prompts/tool descriptions reflect catalog-supported capabilities. Keep plan node binding, failed submissions, source continuation, and conceptual-question behavior unchanged.

### Primary files to inspect

- `src/server/code-runner.ts`, `src/server/code-workspaces.ts`, `src/server/code-submission.ts`, `src/server/api-code-demo.ts`
- `src/core/code-diagnostics.ts`, `src/core/code-workspace.ts`
- `components/code-workbench.tsx`, `components/code-editor.tsx`, `components/new-coding-workspace.tsx`
- `src/server/coding-generation.ts`, `src/agent/teacher-agent.ts`
- `src/agent/prompts/teacher/25-coding.md`, `src/agent/prompts/practice/20-code-exercises.md`
- `app/code-demo/page.tsx`, `app/code-demo/session/[id]/page.tsx`, `app/code-demo/teaching/[chatId]/[nodeId]/page.tsx`, `app/code-demo/examples/page.tsx`

Pass serialized server readiness through existing page/service boundaries where practical. A new public catalog endpoint is unnecessary unless an actual consumer lifecycle requires it.

### Acceptance

- Existing C++ demos, generated projects, Teaching, and Practice retain behavior through the new provider.
- Run completion and assessment verdict are independent; a successful custom run does not manufacture an assessment failure.
- Editing source or other relevant snapshot inputs invalidates new evidence; foreign/ended/reused exercise evidence remains rejected.
- Legacy drafts and checks continue to reopen and submit under legacy validation.
- C++-specific setup and diagnostics no longer live in generic workspace orchestration/UI.

## Milestone 3 Python provider and complete integration

### Deliverables

Register `python` and `python3-stdio`. Require Python 3.11 or newer, discovered using trusted server-owned candidate commands. Try `python3`, then `python`; on Windows also support the `py -3` launcher as a command-plus-fixed-arguments candidate. Verify the actual major/minor version; do not mistake an old Python or a missing-runtime launcher for an available runtime. Do not install Python or change authentication or shell configuration.

Use `solution.py` as the editable entry point. Allow validated relative `.py` supporting module paths and standard-library imports. Use the existing per-file, project-size, test-count, input/output, concurrency, and timeout limits; enforce the strictest applicable existing authoring limits. No `compile_flags.txt` should be created for Python.

Run a syntax-validation preparation phase using a trusted helper that compiles source to validate syntax without executing learner code or writing bytecode. Validate every executable Python resource. Execute each check in a fresh process with the workspace as its working directory. Use fixed Python flags `-E -S -B -u` for this initial standard-library profile: ignore Python environment variables, omit site initialization, suppress bytecode writes, and unbuffer output while retaining the script directory for local supporting imports. Reuse the sanitized process environment. Do not use `-I`, which would remove the local script directory from import search paths. This is interpreter configuration, not an OS sandbox.

Keep the shared stdin/stdout assessor unchanged. Distinguish missing/unsupported runtime, syntax preparation error, runtime exception/nonzero exit, incorrect output, timeout, cancellation, and output-limit termination in evidence. Preserve raw logs. Map syntax locations and traceback frames only to actual workspace resources. Support-file failures must not be underlined in the learner file. Use line-only diagnostics when column precision is unavailable.

Add `@codemirror/lang-python` and register Python syntax/indentation. Do not apply the C++ completion/hint engine to Python. Add a prepared Python example. Enable Python in shared authoring schemas, generator profile instructions, Teaching/Practice prompts, plan-linked coding, selectors, and saved-session validation. Missing runtimes must yield an actionable readiness result while leaving editing and reopening available.

### Acceptance

- Actual Python processes cover correct output, incorrect output, syntax errors, runtime exceptions, timeout, cancellation, excessive output, local supporting-module imports, standard-library imports, Unicode output, and unavailable/unsupported runtimes.
- Python source can be generated, saved, reopened, checked, and submitted using server-owned evidence in standalone Coding, Teaching, and Practice.
- A failing attempt can be submitted for help; stale or forged successful results are rejected.
- Python highlighting/indentation and traceback diagnostics work without C++ assumptions or misleading compilation labels.
- Adding Python requires provider/catalog/editor registrations and profile authoring fragments, without Python branches in generic persistence, assessment, or submission logic.

## Verification and review protocol

Use test fixtures and temporary `LH_DATA_DIR`/`LH_AUTH_FILE`; never run tests against the learner's real application data. Run targeted checks at each milestone, then the complete suite and build at the final milestone. Do not assert that skipped runtime tests prove execution.

Relevant existing suites include:

```text
tests/code-runner.test.ts
tests/code-workspaces.test.ts
tests/code-submission.test.ts
tests/code-diagnostics.test.ts
tests/code-practice-flow.test.ts
tests/practice-code-exercises.test.ts
tests/generated-coding-workspace.test.ts
tests/api-code-demo.test.ts
tests/teaching-code-contract.test.ts
tests/teaching-code-workspace.test.ts
tests/teaching-code-workspace.test.tsx
tests/teaching-coding-routing.test.ts
tests/render-code-workbench.test.tsx
tests/code-workbench-diagnostics.test.tsx
tests/code-editor-vim.test.tsx
```

Add focused tests for the new catalog/contracts, exact legacy identity and saved-run compatibility, and Python behavior. Parameterize existing language-neutral regressions where useful; do not merely duplicate implementation assertions.

Repository validation commands:

```sh
npm run typecheck
npm test
npm run lint
npm run build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs --electron
```

Before milestone 1, record baseline failures separately from regressions. At each gate, Claude reports changed files, design notes, exact commands and exit statuses, test pass/fail/skip counts, and remaining limitations. Codex inspects the diff, independently verifies the relevant checks, and returns concrete corrections when needed. Claude implements those corrections and repeats affected checks before the gate is accepted. Only then start the next milestone.

At completion, update `docs/code-workspaces.md` for the supported C++ and Python profiles and requirements. Supply a final implementation summary and actual validation outcomes. Do not claim an installed application was rebuilt or deployed.
