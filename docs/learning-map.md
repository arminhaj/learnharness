# Learning map

The home map has two views of the same concepts. Prerequisites uses the existing dot canvas with direct concept-to-concept arrows. Iceberg groups concepts commonly studied together and derives group depth from the prerequisite connections between groups. Existing logical arguments remain available in Chains; they are not reinterpreted as learning prerequisites.

Understanding is separate from readiness. Unassessed means there is no assessment evidence, Learning records demonstrated difficulty or partial understanding, and Comfortable requires a learner explanation, solution, or substantive recall. A concept is ready when all its recorded prerequisites are comfortable. Readiness does not establish understanding or imply the prerequisite map is exhaustive.

Press a dot or an iceberg concept to open its details. Names, tags, symbols, understanding, and prerequisite connections can be corrected. Symbol search accepts notation, plain names, aliases, and meanings. Details show when the concept was added, when it was first encountered, and links to the relevant conversation passages. Planned concepts have no invented encounter date or understanding.

## Automatic updates

The configured extraction model maintains the learning layer after teaching and practice turns and notes extraction. It reads learner-authored evidence separately from teacher prose; notes can establish concepts and connections but cannot demonstrate personal understanding. The updater records why it inferred an assessment or prerequisite and retains source message IDs. Update map backfills existing conversations through the same pipeline. Jobs, cancellation, and model usage appear in the existing activity/cost surfaces. Automatic assessments remain inferences and can be corrected in details.

Human corrections take precedence over subsequent automatic contributions. Use automatic clears an understanding or prerequisite override. Reset metadata returns the name, tags, and symbols to automatic values. Editing only a name does not pin the automatically maintained tags or symbols.

Map updates show the current batch, completed batches, model activity, elapsed time, and time since the last model event. Expand the background activity row for response counters and the latest saved concept, prerequisite, and group counts. The graph shows the same details. Counters describe received events and output characters, not estimated tokens or a percentage of model reasoning.

After two minutes without an event, the display calls out the quiet period. Long reasoning can be silent, so this does not establish that a request has stalled. A disconnected notification channel has a separate reconnecting notice: displayed progress may be out of date. These indicators never automatically cancel or retry model work. Only timestamps and counts are exposed; streamed reasoning, text, and tool arguments are not included in progress payloads.

## Storage and integration

- `graph/learning.json` stores versioned automatic contributions, human overrides, and deleted identities, separately from the original reasoning ledgers.
- `graph/learning-positions.json` stores curriculum coordinates, independent of background reasoning layout. Presentation updates preserve live coordinates, camera state, and pending drag commits.
- `GraphSnapshot.learning` contains effective concepts, direct prerequisites, groups, group edges, readiness, and cycle information. Legacy graphs work without a sidecar; no inference edges are automatically copied into it.
- `PATCH /api/graph/nodes/:id` updates metadata or understanding; `PATCH /api/graph/prerequisites` adds, removes, or resets a prerequisite correction. Both return the effective learning snapshot and graph revision.
- `POST /api/graph/learning/refresh` accepts `{}` for existing conversations or `{ "chatId": "…" }` for one. Optional `"incremental": true` processes only new or changed evidence using automatic-update checkpoints; completed chunks of an initial backfill survive a server restart. It requires the configured extraction model and provider connection.
- `graph-changed` events refresh open views after writes. Source deletion removes that source's automatic evidence while retaining concepts supported elsewhere. Node deletion also cleans metadata and connections.

Prerequisite cycles from automatic output remain visible at a shared depth; the sidebar rejects a new manual connection that would introduce a cycle. Group unlocks include only concepts whose remaining prerequisites can all be satisfied by that group. There are no helper vertices in the prerequisite canvas.
