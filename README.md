<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="https://learnharness.ai">Download</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/amosblomqvist/learnharness/issues">Issues</a> ·
  <a href="https://discord.gg/5tCHHQEB2e">Discord</a>
</p>

LearnHarness uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![LearnHarness teaching session](docs/assets/teaching-session.png)

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

The agent can also research questions in the background, create visual explanations, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

## Download and get started

**[Download from learnharness.ai](https://learnharness.ai)** · [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases)

- **macOS (Apple Silicon):** signed and notarized DMG. Drag the app to Applications.
- **Windows (x64):** run the installer. It is currently unsigned; Windows may show an “unknown publisher” or SmartScreen warning.
- **Linux (x64):** make the AppImage executable and open it, or install the Debian/Ubuntu `.deb`.

Add your provider API key and choose your models, then start a session with what you want to understand. LearnHarness supports 30+ provider options, including OpenAI, Anthropic, Google, DeepSeek, and OpenRouter. Optional dictation and web search use separate service keys.

All three platforms support in-app updates.

**Dictation:** Create a [Deepgram API key](https://console.deepgram.com/) with the **Member role or higher** ([required for token minting](https://developers.deepgram.com/reference/auth/tokens/grant)) and add it under **Settings → Providers → Dictation**. Choose the language below the key; **Multilingual** supports automatic recognition and mixed-language speech. A `403 Insufficient permissions` error during token minting can indicate an insufficient key role.

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. You pay your providers for usage; a live cost meter shows model costs.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## Development and support

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic, no LLM, no network
```

See the [development guide](docs/development.md), [architecture](docs/architecture.md), and [desktop release guide](docs/desktop-release.md).

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues).

## Chemistry interface

This fork renders molecular skeletal drawings directly in lessons, questions, answer options, and explanations. Open **Expand** for a larger drawing, **Copy structure** for chemical source, **Edit a copy** to explore changes, or **View 3D** for a rotatable model. In an active free-response question or chemistry practice problem, **Use in answer** copies the displayed structure into the learner's independent drawing workspace. Changing the copy does not change the question.

**Draw structure** opens the Ketcher editor. Save a drawing to attach it to the answer, then send it with any written reasoning. Drafts survive closing the editor and reloading the same question; each submitted answer retains its own structure. Multiple-choice questions still submit the selected option, while free-response questions and practice problems can submit a molecular document. Parsing establishes that a structure can be represented; the tutor still assesses its chemistry against the problem.

### Authoring structures

Use a `molecule` fence with a JSON source record:

````markdown
Which functional group is present in this structure?

```molecule
{"version":1,"smiles":"CC(=O)OCC","label":"Structure A"}
```
````

For a plain SMILES source, a `smiles` fence is also supported:

````markdown
```smiles
C[C@H](O)CC
```
````

Records accept `smiles` or `molfile`, an optional neutral `label` and `caption`, and optional single-molecule `sdf` coordinates. A Molfile takes precedence when both Molfile and SMILES are present. Supplied 3D coordinates must describe the same structure. Keep labels and captions neutral when naming a molecule is part of the question. Preserve formal charges, isotopes, and specified stereochemistry in the source.

For practice tools, include `chemistry: {}` in a `problem` call to offer a blank editor. Optional `chemistry.startingStructure` is a SMILES string for a given starting molecule; `chemistry.instructions` contains public drawing instructions. The expected answer belongs in the hidden `modelSolution`, never in the starting drawing. Submitted structures retain Molfile and editor data, with derived SMILES for interchange. Markdown exports retain portable molecule source fences; they do not embed rendered image files.

### Local setup and 3D

The chemistry dependencies require **Node.js 24.14.1 or newer**. Install dependencies and prepare the locally served drawing/viewer assets:

```bash
npm install
npm run chemistry:assets
npm run dev
```

`predev` and `prebuild` also prepare the assets automatically. No CDN is needed for rendering or editing. The `/chemistry` page provides examples of graphical questions, drawing answers, and stereochemistry.

Generating a 3D model from a 2D drawing additionally requires local Python RDKit:

```bash
python3 scripts/setup-chemistry.py
```

The setup script creates an isolated `.venv-chemistry` environment and installs the pinned RDKit version. It uses `uv` with Python 3.12 when available, or the invoking Python's `venv` and `pip`. Alternatively, set `LH_CHEMISTRY_PYTHON` to the absolute path of a Python interpreter with RDKit installed before starting LearnHarness. Installation downloads dependencies; subsequent rendering, editing, and conformer generation run locally.

Generated models use ETKDG and a supported force field, preserve specified stereochemistry, and are labeled as one possible conformer. Unspecified stereochemistry is called out. Imported valid 3D SDF coordinates can be viewed without the Python generator. Generation supports one connected molecule with up to 200 non-hydrogen atoms; failures remain local to the 3D panel, and the 2D drawing remains available.

Standalone/Electron builds include the JavaScript/WASM assets and Python helper script, **but do not bundle a Python interpreter or `.venv-chemistry`**. Configure `LH_CHEMISTRY_PYTHON` on the machine running the packaged server to enable generated 3D there. The renderer/editor remain available without it.

Focused checks:

```bash
NODE_ENV=test node --import tsx --test tests/chemistry*.test.ts
```

The engine tests exercise invalid inputs, charge/isotope/stereo round trips, coordinate-source consistency, and API errors. Real conformer tests run when the configured or project-local Python runtime exists, otherwise they are skipped. Browser checks additionally cover drawing layout, editor save/reopen, keyboard isolation, and 3D interaction.

The chemistry integrations use [RDKit](https://github.com/rdkit/rdkit) (BSD-3-Clause), [Ketcher](https://github.com/epam/ketcher) and its Indigo engine (Apache-2.0), and [3Dmol.js](https://github.com/3dmol/3Dmol.js) (BSD-3-Clause). Asset preparation includes their copyright and license notices. Versioned upstream copies and provenance are in [third-party/chemistry](third-party/chemistry/README.md); preserve these notices when redistributing the application and prepared assets.

## License

[AGPL-3.0](LICENSE)

The app is free and open forever. If we ever charge for anything, it will be for convenience — managed keys, hosting — never for features you can run locally.
