# Learning history — first draft

The sidebar has one **Learning history** entry at `/history`. Its horizontal tabs contain Turning points, Successful strategies, and Then & now. The page uses the existing app typography, colors, borders and `TopBar`.

Opening the page starts a resumable backfill of existing sessions using the configured extraction model. Once enabled, settled teaching turns update the history automatically. No new learner journal is required. The page reports session coverage, failures and active work; Stop update retains completed work. A provider must be configured to analyze new material, but saved history and explicit markers can be read without one.

## Speech and evidence

1. Project learner-authored prose, historic answers, reading reflections and tutor-visible context from native conversation records. Exclude hidden model reasoning, generated launch prompts, committed solutions and infrastructure messages. Long passages are partitioned rather than truncated.
2. A dedicated coherence editor converts dictation into readable speech **without summarizing**. It preserves incorrect assumptions, negation, uncertainty, examples and meaningful self-corrections. Ambiguous recognition is flagged rather than guessed. Passage identities and speaker boundaries must remain intact.
3. A separate analysis pass identifies candidate episodes using cleaned speech. A later substantive learner explanation is required; tutor exposition and multiple-choice selection alone cannot establish a demonstration. Subject assumptions, learning-process observations and tutor contributions have separate fields. Evidence distinguishes independent application, work with help, explanation and uncertainty.

History passages are labeled as edited speech, not verbatim quotations. Learners can correct wording and add context to an interpretation. Wording changes invalidate derived interpretations until reanalysis. Strategies are observations with source episodes and reusable cues, not permanent learning-style labels. Replay groups explanations of the same concept across sessions and leaves an unavailable earlier explanation unknown.

## Explicit moments

Select text in a teaching session or inline exploration, then choose **Mark this moment** → **This clicked** (or Still unsure / My assumption), with an optional note. Saved passages stay highlighted; clicking a highlight or its saved-marker button reopens the annotation. Learning history links return to that exact passage. A message can contain several separately editable markers; existing whole-message markers remain usable. Only explicit learner actions create markers. Each records both its source-message time and the actual time the learner marked it. Backfill cannot manufacture retrospective learner signals. Markers save without a model connection and can be changed or removed.

Selection anchors store a stable source block, visible-text offsets and a content fingerprint, not another copy of raw dictated wording. Controls, draft fields, hidden math copies and nested explorations are excluded from offsets. If the source text changes, the marker remains saved but the UI refuses to highlight a different phrase. Analysis uses cleaned message context; rendered selection offsets are not treated as positions in cleaned speech.

## Persistence and runtime

- `src/core/learning-history.ts`: contracts, source projection, evidence validation, batching and replay grouping.
- `src/agent/subagents/learning-history.ts`: separate coherence and analysis submit agents, using the existing extraction-model setting.
- `src/server/learning-history.ts`: incremental queue, checkpoints, source validation, corrections and deletion cleanup.
- `src/store/learning-history.ts`: atomic `graph/learning-history.json` sidecar under the configured data directory. It stores cleaned passages and source fingerprints; native conversation records remain intact for agent continuation.
- `/api/learning-history`: read snapshots or session marker targets, request/cancel updates, and save learner changes. `learning-history-changed` refreshes subscribed views.

Completed cleanup and analysis batches survive interruption and restart. Source fingerprints prevent edited or deleted messages from contributing stale evidence. Concurrent learner changes are read again after every model await. History model usage is recorded in the existing extraction usage log with `purpose: "learning-history"`.

The queue is in-process for the app's existing single-server deployment. Restarting the app stops active work; reopening history resumes from persisted checkpoints. Replay drafts currently stay on the page and are explicitly unassessed. Semantic fidelity of speech cleanup still needs evaluation with real dictation; automated checks cover structure, source attribution and retry behavior, not the quality of a live model's judgment.

## Verification

`tests/learning-history.test.ts` exercises old-history recovery, exclusions, long dictation, coherence-agent retries, evidence validation, resumability, corrections, concurrent markers, cancellation, deletion and cross-session replay. Browser checks use an isolated data directory and scripted analysis fixtures, including saving a strategy, replay hide/reveal, source navigation, interpretation correction and marking a session moment. `tests/learning-moment-dom.test.ts` checks selection boundaries, repeated text, formatting, scope isolation and changed-source rejection. Marker service tests cover multiple selections, duplicate prevention, edits and removal. Browser verification also covers selecting a phrase, adding a note without submitting an answer, reloading a persistent highlight, and returning from history to the selected passage. Real teaching data and provider credentials are not needed for those checks.
