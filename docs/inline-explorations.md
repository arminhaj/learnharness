# Inline explorations

Use an exploration to follow a tangent while keeping the teaching lesson at its current question.

1. Under a completed tutor explanation, choose **Explore this**.
2. Enter the question you want to explore and choose **Explore**.
3. Continue inside the inline block. The original lesson is paused.
4. Choose **Return to lesson** when the response has finished. The block collapses and the original question, answer draft, cursor and reading position return.

Returned explorations stay attached to their source passage. Expand one to read it, or choose **Continue exploring** to resume it. They do not add sessions to the sidebar. Knowledge-graph source links open the relevant exploration inside its parent lesson.

## Boundaries

- A teaching lesson can have one active exploration at a time. Practice sessions and nested explorations are not supported.
- Starting requires the lesson's response, compaction and background work to have finished. Returning requires the exploration's response to finish; its Stop control can end a response first.
- The parent lesson's pending question, plan and transcript are preserved. Neither exploring nor returning answers the pending question, advances the plan or marks a concept mastered.
- An exploration receives visible source prose and limited nearby lesson context. Hidden reasoning, tool arguments and unrevealed quiz answers are excluded.
- Exploration text does not automatically enter the parent tutor's next input. There is no automatic summary or carryback into the lesson.
- The exploration inherits the lesson's model settings. Model setup and provider errors remain visible. Creation and returning do not themselves make model calls.
- When graph extraction is enabled, contributions remain in the parent lesson's graph group while retaining the exploration's actual message provenance. Existing extraction and model settings still apply; reading an explanation does not establish mastery.
- Unsent exploration text is retained in this browser's session storage for reopening. Parent draft and cursor preservation applies while the lesson remains mounted; it is not a new cross-device or reload draft-sync feature.

## Implementation

Explorations use separate chat records with `exploration` metadata: parent ID, source message ID, parent title, topic and active/closed status. A dedicated conversational agent has no question or plan tools. The lesson view remains mounted while an independent session hook streams the inline conversation.

The server enforces the pause before parent transcript mutations, including automatic continuations. The client also suspends lesson input, dictation claims and question keyboard handlers without unmounting the draft fields. Returning restores the dock's prior expanded state and focus rather than synthesizing a new lesson message.
