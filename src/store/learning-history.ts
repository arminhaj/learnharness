import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emptyLearningHistory, historyStateSchema, type LearningHistoryStore } from "../core/learning-history.ts";

export function createLearningHistoryStore(file: string): LearningHistoryStore {
	return {
		read() {
			try { return historyStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLearningHistory(); throw error; }
		},
		write(state) {
			const valid = historyStateSchema.parse(state);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const temporary = `${file}.${crypto.randomUUID()}.tmp`;
			try { fs.writeFileSync(temporary, JSON.stringify(valid)); fs.renameSync(temporary, file); }
			finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
		},
	};
}
export const learningHistoryStore = createLearningHistoryStore(path.join(PATHS.graph, "learning-history.json"));
