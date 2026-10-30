# Coding exercises

For C++ implementation problems, add `codeExercise` to the `problem` call. Set `language` to `cpp`; C++20 is currently the only executable language. Omit this field for other languages and for conceptual questions that do not call for an implementation.

`starterCode` is the entire source file: standard-library includes, the function or class the learner must complete, a placeholder body that compiles, and a working `main` that reads standard input and writes standard output. Supply the boilerplate so the learner can focus on the intended task. Use standard C++20 only, with no downloaded dependencies, shell commands, custom compiler flags, or generated build scripts. Keep source within 64 KiB UTF-8.

Keep the true implementation in the private `modelSolution` commitment. Never put it in the starter, its comments, or the problem statement. The starter must compile but fail at least one correctness check until the learner implements the missing behavior. Solve the exercise yourself before posing it and verify each expected output against that solution; do not claim the compiler or tests were run unless actual run results are present.

Provide 1–12 deterministic `tests`, each with `name`, `stdin`, and `expectedStdout`. Test names are at most 120 characters; each input and expected output is at most 8 KiB UTF-8. Cover the intended behavior and relevant boundary cases. The statement must explain the input/output contract and identify what to implement. Checks are examples of correctness, not a hidden requirement that contradicts the statement.

The learner may edit the source in the answer field or open its generated workspace in an external editor. On submission, evaluate the exact submitted source together with any actual compiler diagnostics and test results. Distinguish compilation failure, runtime failure, and incorrect output. Successful compilation only establishes that the compiler accepted the program. Passing the supplied cases is evidence within their coverage, not proof of correctness for all inputs; assess the implementation and the problem's requirements as well. Missing or unavailable run results are not a pass.

Apply the existing hint and conclusion rules to coding attempts: localize the first break, give only the requested help, and leave the problem active for another attempt. Never conclude merely because compilation succeeded or because an attempt failed.
