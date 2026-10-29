# Inline explorations

Use an exploration to branch into a focused teaching lesson while keeping the main lesson at its current question.

1. Under a completed tutor explanation, choose **Explore this**.
2. Enter the question you want to explore and choose **Explore**.
3. The branch uses the surrounding lesson context, skips initial probing, and presents its own small plan. After you confirm the approach, it teaches one reasoning step at a time with the same understanding checks as the main lesson.
4. Continue inside the inline block. Its plan, checks, answers and resources belong to the branch; the main lesson is paused.
5. Choose **Return to lesson** when the response and background work have finished, even if a branch check is unanswered. The block collapses and the original question, answer draft, cursor and reading position return.

Returned explorations stay attached to their source passage. Expand one to read it, or choose **Continue exploring** to resume its own plan and pending question. They do not add sessions to the sidebar. Knowledge-graph source links open the relevant exploration inside its parent lesson.

Dictation uses the same recorder as the main lesson. Speech appears when recording stops: in reading notes before revealing a check, and in the answer or thinking field afterward. For a spoken free-response answer, **Submit answer** or Enter finishes recording and includes the final words before submitting. An empty recording never submits an empty answer. Revealing a check or returning to the lesson finishes the current recording before changing its destination.

## Boundaries

- A teaching lesson can have one active exploration at a time. Practice sessions and nested explorations are not supported.
- Starting requires the lesson's response, compaction and background work to have finished. Returning requires the exploration's response, compaction and background work to finish; its Stop control can end a response first.
- The parent lesson's pending question, plan and transcript are preserved. Neither exploring nor returning answers the pending question, advances the plan or marks a concept mastered.
- An exploration receives visible source prose and limited nearby lesson context. Hidden reasoning, tool arguments and unrevealed quiz answers are excluded.
- Exploration text does not automatically enter the parent tutor's next input. There is no automatic summary or carryback into the lesson.
- The exploration inherits the lesson's model settings and uses the normal teacher instructions, prompt overrides, question mechanic and enabled tools. Model setup and provider errors remain visible. Creation and returning do not themselves make model calls.
- When graph extraction is enabled, contributions remain in the parent lesson's graph group while retaining the exploration's actual message provenance. Existing extraction and model settings still apply; reading an explanation does not establish mastery.
- Unsent exploration text is retained in this browser's session storage for reopening. Parent draft and cursor preservation applies while the lesson remains mounted; it is not a new cross-device or reload draft-sync feature.

## Implementation

Explorations use separate chat records with `exploration` metadata: parent ID, source message ID, parent title, topic and active/closed status. The teacher's tools bind to the child record, so its plan, node validation, question answers and background jobs cannot advance the parent lesson. The normal teacher prompt is composed with a final exploration-specific instruction: skip initial probing, keep the plan focused, and preserve the parent boundary. No synthetic probe completion is inserted.

The lesson view remains mounted while an independent session hook streams the inline conversation. The branch renders the normal plan, question and resource components and submits answers using its own session. Understanding checks stay behind **Check your understanding** until the learner is ready.

The server enforces the pause before parent transcript mutations, including automatic continuations. The client also suspends lesson input, dictation claims and question keyboard handlers without unmounting the draft fields. Returning restores the dock's prior expanded state and focus rather than synthesizing a new lesson message.
