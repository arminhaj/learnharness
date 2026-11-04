# All-features preview

`codex/all-features-preview` includes upstream LearnHarness 0.4.0, Light/Dark/System appearance modes, nested lesson explorations with dictation controls, subject-aware learning maps, learning history, the Coding workspace, the chemistry interface, problem-set teaching, and feedback-first teaching with research and reply recovery.

The node graph overhaul is merged into `main`. Learning history, the Coding workspace, the chemistry interface, and problem-set teaching retain their own experimental branches; completed commits from those branches are integrated here and remain outside `main`.

## What to try

- Open **Settings → Appearance** and switch among Light, Dark, and System. The graph and lesson diagrams follow the selected mode without losing their layout or your draft.
- Open **Settings → Providers → External CLI** to configure the optional Claude Code integration. Upstream custom endpoints and file-path attachments are included too.
- On Home, open a concept from the prerequisite dots or the iceberg. Try its metadata, subject correction, **Learn this concept**, and **Test my understanding** actions.
- In Iceberg, change **Subject**. Concepts, study groups, progress counts, unlocks, and search results stay within that subject.
- In a **teaching session**, choose **Explore this** beneath a completed tutor explanation. Choose **Explore this** again inside the tangent to go deeper. Use **Return to parent** or **Return to lesson** to resume the question and draft one level up. Inline explorations are not available in practice sessions.
- To work through an assignment, start a **Teaching** session with its file path and ask to work through every question. The teacher starts at Question 1, labels original assigned questions, teaches prerequisites as needed, and retains checked guided solutions and unfinished subparts. See [problem-set teaching](problem-set-teaching.md).
- After submitting an answer, look for feedback on your reasoning before optional research or preparation for the next question.
- After answering, inspect automatic understanding updates and their source links. Evidence from an inline exploration should open the exact passage inside its parent lesson. Reading an explanation alone does not mark a concept understood.
- Open **Learning history** in the sidebar, or select a passage in a teaching session and choose **Mark this moment**. See [learning history](learning-history.md) for analysis, speech cleanup, and source attribution.
- Choose **Coding** in the sidebar to open guided C++ exercises with hints, references, and runnable checks. Choose **Add two integers** or **Borrow a book** in the workspace. See [code workspaces](code-workspaces.md) for compiler and local execution requirements.
- Open `/chemistry` to try molecular drawings, editable structure answers, and rotatable 3D views. Questions and practice problems preserve both molecular answers and code submissions. See [chemistry setup](../README.md#chemistry-interface) for the optional local Python RDKit setup required to generate 3D conformers.

## Desktop launch

For ordinary development, install dependencies and run `npm run desktop:dev` from this checkout. Pi requires Node 22.19 or newer; this integration's full test suite was verified with Node 26.12.1. This command launches the Electron shell against the checkout's development server. The prepared launcher uses Electron's bundled Node 24.22.0 and does not depend on your shell's Node version.

A prepared local preview launcher may instead point at an immutable production build of this branch. Use that launcher to keep the intended conversations, settings, and graph data together. A separately installed LearnHarness app does not select this branch merely because this checkout is open.

Finish unsent answers and dictation before switching desktop builds. Run only one server per provider-credential directory; the local preview launcher refuses to take over an occupied port or another LearnHarness credential owner.
