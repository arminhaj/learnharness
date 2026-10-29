# All-features preview

`codex/all-features-preview` starts from main with Light/Dark/System appearance modes and inline explorations, and merges the subject-aware learning-map work.

## What to try

- Open **Settings → Appearance** and switch among Light, Dark, and System. The graph and lesson diagrams follow the selected mode without losing their layout or your draft.
- On Home, open a concept from the prerequisite dots or the iceberg. Try its metadata, subject correction, **Learn this concept**, and **Test my understanding** actions.
- In Iceberg, change **Subject**. Concepts, study groups, progress counts, unlocks, and search results stay within that subject.
- In a **teaching session**, choose **Explore this** beneath a completed tutor explanation. Follow the tangent, then choose **Return to lesson** to resume the original question and draft. Inline explorations are not available in practice sessions.
- After answering, inspect automatic understanding updates and their source links. Evidence from an inline exploration should open the exact passage inside its parent lesson. Reading an explanation alone does not mark a concept understood.

## Desktop launch

For ordinary development, install dependencies and run `npm run desktop:dev` from this checkout. Pi requires Node 22.19 or newer; this integration's full test suite was verified with Node 26.12.1. This command launches the Electron shell against the checkout's development server. The prepared launcher uses Electron's bundled Node 24.22.0 and does not depend on your shell's Node version.

A prepared local preview launcher may instead point at an immutable production build of this branch. Use that launcher to keep the intended conversations, settings, and graph data together. A separately installed LearnHarness app does not select this branch merely because this checkout is open.

Finish unsent answers and dictation before switching desktop builds. Run only one server per provider-credential directory; the local preview launcher refuses to take over an occupied port or another LearnHarness credential owner.
