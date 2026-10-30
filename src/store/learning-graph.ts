import * as fs from "node:fs";
import * as path from "node:path";
import { LEARNING_GRAPH_FILE } from "../../config.ts";
import { emptyLearningGraphState } from "../core/learning-graph.ts";
import { parseLearningGraphState } from "../core/learning-graph-validation.ts";
import type { LearningGraphStore } from "../core/ports.ts";

/** Missing means an untouched legacy graph. Corrupt/newer files fail loudly:
 * a metadata edit must never replace an unreadable record with empty state. */
export function createLearningGraphStore(file: string): LearningGraphStore {
	return {
		read() {
			let raw: string;
			try { raw = fs.readFileSync(file, "utf8"); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLearningGraphState();
				throw error;
			}
			return parseLearningGraphState(JSON.parse(raw));
		},
		write(state) {
			const validated = parseLearningGraphState(state);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const temporary = `${file}.tmp-${crypto.randomUUID()}`;
			try {
				fs.writeFileSync(temporary, JSON.stringify(validated), "utf8");
				fs.renameSync(temporary, file);
			} catch (error) {
				try { fs.unlinkSync(temporary); } catch { /* already moved or not created */ }
				throw error;
			}
		},
	};
}

export const learningGraphStore = createLearningGraphStore(LEARNING_GRAPH_FILE);
