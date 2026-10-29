import * as fs from "node:fs";
import * as path from "node:path";
import { LEARNING_POSITIONS_FILE } from "../../config.ts";
import type { Position } from "../core/contracts.ts";

export function readLearningPositions(): Record<string, Position> | null {
	let raw: string;
	try { raw = fs.readFileSync(LEARNING_POSITIONS_FILE, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const data = JSON.parse(raw) as { positions?: Record<string, unknown> };
		const positions: Record<string, Position> = {};
		for (const [id, point] of Object.entries(data.positions ?? {})) {
			if (typeof point !== "object" || point === null) continue;
			const { x, y } = point as Record<string, unknown>;
			if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) positions[id] = { x, y };
		}
		return positions;
	} catch { return null; /* Rebuildable layout, unlike metadata. */ }
}

export function writeLearningPositions(positions: Record<string, Position>): void {
	fs.mkdirSync(path.dirname(LEARNING_POSITIONS_FILE), { recursive: true });
	const temporary = `${LEARNING_POSITIONS_FILE}.tmp-${crypto.randomUUID()}`;
	try {
		fs.writeFileSync(temporary, JSON.stringify({ positions, updatedAt: new Date().toISOString() }), "utf8");
		fs.renameSync(temporary, LEARNING_POSITIONS_FILE);
	} catch (error) {
		try { fs.unlinkSync(temporary); } catch { /* already moved or not created */ }
		throw error;
	}
}
