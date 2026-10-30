# Problem-set teaching

Start a regular Teaching session with the problem set's file path or pasted text and ask to work through it. For example:

> Work through every question in Problem Set 4 at /path/to/problem-set-4.pdf with me. Start with Question 1 and teach prerequisites as we need them.

The teacher reads the source and inventories the questions and subparts before beginning. PDF reading requests a full assignment inventory with page references, rather than a topical summary. Missing or unreadable portions remain explicit gaps that need clarification.

The session begins at the first assigned question and follows source order. It introduces prerequisites when the current question needs them, with examples and understanding checks along the way. An actual assigned question is labeled with the set name and its original question/subpart number before the learner attempts it. Generated examples need no special label, and modified examples are never presented as original assigned questions.

A completed, checked guided solution counts as finished; the learner does not have to solve the entire question again unaided. All requirements and subparts must be accounted for. The numbered solution retains usable working, a final result, and its check. Answering a related example, visiting a concept, or merely seeing a solution does not complete the assigned work.

The conversation keeps the question inventory, partial work, completed solutions, and the next unfinished part. Compaction instructions preserve this record in session summaries so resuming can continue without repeating finished questions. Existing transcript exports include the visible source labels and solution working. Skipped or blocked questions remain unfinished unless the learner explicitly changes the requested scope.

## Implementation

This behavior is model-directed through `shared/35-problem-sets.md`, the prober/teacher instructions, PDF-reader instructions, and the compaction prompt. It uses the existing Teaching session and transcript storage. Progress is maintained in the conversation and summaries; it is not a separately validated completion counter. The concept dependency map retains its existing meaning and does not stand in for assignment completion.

The shared fragment reaches prober and teacher, including existing sessions on their next turn. Practice's curated prompt list excludes it. An explicit walkthrough request activates the full workflow; simply mentioning an assignment does not redirect an ordinary lesson. Source labels apply whenever a teaching question is taken directly from a problem set. Enabled custom prompt overrides can change these behaviors.
