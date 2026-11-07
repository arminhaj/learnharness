# Coding workspace implementation review

Claude Code implemented all three milestones in `all-features-preview`. Codex reviewed each diff, requested corrections, and independently verified the coding regressions before accepting the next milestone. Two additional agents reviewed backend compatibility and UI/authoring behavior without editing implementation.

The installed Claude Code CLI used its existing account authentication. No credentials or global settings were changed. Tests used temporary data and authentication fixtures. The installed LearnHarness application was not redeployed.

## Checkpoints

All checkpoints were pushed to `origin/codex/all-features-preview` in [arminhaj/learnharness](https://github.com/arminhaj/learnharness/tree/codex/all-features-preview).

| Checkpoint | Commit | Result |
| --- | --- | --- |
| Existing preview changes | `9855b78` | Preserved all 193 changed/new files before implementation |
| Implementation handoff | `f84ba9d` | Recorded approved scope, compatibility requirements, gates, and acceptance tests |
| Shared contracts and catalog | `0bd1b15` | Browser-safe normalized activity/evidence contracts, shared schema, explicit supported profiles |
| C++ migration | `b193cf9` | Trusted C++ provider, independent execution/assessment, snapshots, structured diagnostics, readiness |
| Python | `eeb271e` | Python 3.11+ provider, editor, examples, generation, Teaching/Practice, and submission integration |

## Implemented behavior

Both C++20 and Python 3.11+ use the same workspace, revision, execution-evidence, stdio-assessment, and authoritative-submission flow. Registered support is distinct from installed-toolchain readiness. Saved work remains editable without the toolchain, and older C++ workspace identities, drafts, and check records remain compatible.

Python discovery skips unsupported interpreters and continues to another candidate. On this machine it skips `/usr/bin/python3` 3.9.6 and uses the existing `/opt/anaconda3/bin/python` 3.12.7. Syntax validation compiles every Python resource without executing learner code, and helper imports are isolated from learner modules. Execution retains local imports and uses a fresh process per case. No packages or Python runtime are installed by the runner.

Nested supporting modules, empty `__init__.py` files, Unicode I/O, syntax errors, runtime tracebacks, and line-only diagnostics are supported. Teaching and Practice obtain capability descriptions from the catalog, including when prompt prose is overridden. Native plan-linked exercises validate language aliases and reject a mismatch with an explicitly language-bound step.

## Review corrections

Review caught and Claude corrected these issues before acceptance:

- Preserved exact legacy exercise hashing and saved-run compatibility; removed a C++ type assertion from the shared schema.
- Increased the saved-result bound to account for duplicated, JSON-escaped evidence, and rejected oversized records before publishing `lastRunId`.
- Included effective ordered build-source selection in snapshots and retained same-line diagnostic end positions.
- Preserved cancellation during Python discovery and exact bytes in empty/padded Python support files.
- Flushed stream decoders at EOF so an incomplete UTF-8 sequence cannot disappear and falsely pass an empty-output test.
- Converted Python character offsets to UTF-16 editor columns, with line-only fallback when mapping is unreliable.
- Expanded syntax-failure output immediately and removed compiler-specific wording from shared surfaces.
- Restored unrelated lockfile metadata and completed catalog-generated tutor guidance.

## Validation

| Check | Result |
| --- | --- |
| Initial coding baseline | 50 passed, 0 failed, 0 skipped; typecheck passed |
| Milestone 1 independent coding checks | 108 passed, 0 failed, 0 skipped; typecheck and focused lint passed |
| Milestone 2 independent coding checks | 123 passed, 0 failed, 0 skipped; typecheck and full lint passed |
| Final isolated candidate coding checks | 177 passed, 0 failed, 0 skipped across 24 suites |
| Final isolated candidate typecheck/lint | Both passed |
| Corrected-source full suite run by Claude | 3,765 tests: 3,754 passed, 3 failed, 8 skipped |
| Independent full suite on isolated candidate | 3,765 tests: 3,753 passed, 4 failed, 8 skipped; see below |
| Production build | Passed on corrected final source |
| Provider runtime smoke | Passed |
| Server payload build | Passed |
| Electron/server smoke | Passed: boot, API probes, curved-arrow round trip |
| Independent payload checks with local dependencies | 4 passed, 0 failed, 0 skipped |

Three deterministic full-suite failures reproduce on the clean pre-implementation baseline:

- `provider-tracing.test.ts`: runtime tracing exclusions assertion.
- `question-core.test.ts`: `explainInputBase` authoring-field assertion.
- `subscription-auth.test.ts`: main-loader public exports/native OAuth assertion.

The independent full run additionally encountered the unchanged `claude-code-tool-bridge.test.ts` arrival-order test intermittently reversing two HTTP requests. Its whole suite passed when rerun alone on both the candidate and the clean baseline. This test uses a 20 ms delay to assume request order. No bridge implementation or test was changed by the language work. The full suite is therefore not reported as green.

Independent edge probes also confirmed correct split UTF-8 decoding, cancelled discovery evidence, replacement output for incomplete UTF-8 at EOF, and correct syntax positions after an emoji. Actual C++ and Python execution tests ran without skips on this machine. Windows-specific `py -3` discovery was not exercised here.

## Concurrent work and scope

After Claude's final report, another task added historical Teaching-workspace reopening to three shared files and a new `tests/teaching-plan-reopen.test.ts`. Those changes were preserved in the live checkout and excluded from the Python checkpoint. Claude reconstructed the three owned file versions in scratch; reviewers checked them, and Codex tested an isolated candidate containing exactly the 43 files committed in `eeb271e`. No live source was overwritten during isolation.

The supported workflows remain one editable source resource, supporting files, local finite execution, and stdio checks. Package installation, native test-suite profiles, notebooks, debuggers, and remote execution remain future work. See [the implementation handoff](coding-workspace-language-handoff.md) and [workspace documentation](code-workspaces.md) for the architecture and usage.
