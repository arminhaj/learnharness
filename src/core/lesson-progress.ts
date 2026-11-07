import type { PlanTree } from "./contracts/plan.ts";

/** Equal-weight plan steps, explicitly completed by the tutor. */
export function lessonProgress(tree: PlanTree | null | undefined) {
 const ids = new Set(tree?.nodes.map(node => node.id) ?? []);
 const completed = new Set((tree?.completedNodeIds ?? []).filter(id => ids.has(id)));
 const total = ids.size;
 return { total, completed, count: completed.size, percent: total ? Math.round(100 * completed.size / total) : 0 };
}
