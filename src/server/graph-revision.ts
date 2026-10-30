import * as fs from "node:fs";
import { LEDGER_FILES, LEARNING_GRAPH_FILE, LEARNING_POSITIONS_FILE, POSITIONS_FILE } from "../../config.ts";

/** Pure filesystem version: edits, extraction, and layout all invalidate reads. */
export function graphRevision(): number {
	let revision = 0;
	for (const file of [...Object.values(LEDGER_FILES), POSITIONS_FILE, LEARNING_GRAPH_FILE, LEARNING_POSITIONS_FILE]) {
		try { revision = Math.max(revision, fs.statSync(file).mtimeMs); }
		catch { /* no data written yet */ }
	}
	return revision;
}
