/** Persist the curriculum canvas independently from reasoning-extraction
 * layout. Dragging never schedules another layout or moves missing nodes. */
import type { Position } from "../core/contracts.ts";
import { writeLearningPositions } from "../store/learning-positions.ts";
import { effectiveGraphView } from "./learning-graph.ts";

const MAX_COORD = 1e6;

export function commitPositions(input: unknown): Record<string, Position> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
	const snapshot = effectiveGraphView();
	const known = new Set(snapshot.learning!.nodes.map((node) => node.id));
	const positions: Record<string, Position> = {};
	for (const [inputId, value] of Object.entries(input)) {
		const id = snapshot.learning!.idAliases?.[inputId] ?? inputId;
		if (!known.has(id) || typeof value !== "object" || value === null) continue;
		const { x, y } = value as Record<string, unknown>;
		if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) continue;
		positions[id] = { x: Math.min(Math.max(x, -MAX_COORD), MAX_COORD), y: Math.min(Math.max(y, -MAX_COORD), MAX_COORD) };
	}
	if (!Object.keys(positions).length) return {};
	// Preserve known positions omitted by an older window's drag payload.
	const existing = snapshot.positions ?? {};
	const kept = Object.fromEntries(Object.entries(existing).filter(([id]) => known.has(id)));
	const merged = { ...kept, ...positions };
	// A concept may arrive while an older client is dragging. Give only that
	// new concept a deterministic seed; settled coordinates stay byte-exact.
	const established = { ...merged };
	const points = Object.values(established);
	const center = { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
	const radius = Math.max(80, ...points.map((point) => Math.hypot(point.x - center.x, point.y - center.y))) + 60;
	for (const id of [...known].sort()) {
		if (merged[id]) continue;
		const neighbors = snapshot.learning!.prerequisites.flatMap((edge) => edge.from === id ? [edge.to] : edge.to === id ? [edge.from] : []).map((neighbor) => established[neighbor]).filter((point): point is Position => point !== undefined);
		const anchor = neighbors.length ? { x: neighbors.reduce((sum, point) => sum + point.x, 0) / neighbors.length, y: neighbors.reduce((sum, point) => sum + point.y, 0) / neighbors.length } : center;
		let hash = 2166136261;
		for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
		const angle = hash / 0x100000000 * Math.PI * 2;
		const distance = neighbors.length ? 60 : radius;
		merged[id] = { x: anchor.x + Math.cos(angle) * distance, y: anchor.y + Math.sin(angle) * distance };
	}
	writeLearningPositions(merged);
	return positions;
}
