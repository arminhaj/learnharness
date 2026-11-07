import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { PlanToolResult, PlanTree } from "../../core/contracts.ts";
import type { ChatStore } from "../../core/ports.ts";
import { createTree, PlanTreeError } from "../../core/plan-tree.ts";
import { parseMermaidPlan } from "./mermaid-plan.ts";

/** The binding-id reminder riding plan_init's slim content (owner,
 *  2026-10-09): plan_init is the exact moment the node ids become
 *  load-bearing — every later quiz/explain call must reference one. The
 *  field-drop incidents (tools_fails_2) showed the turn's tail is where
 *  discipline slips; the reminder lands right there. */
const PLAN_NODE_IDS_REMINDER =
	"These are the plan's node ids — the only valid nodeId values for every quiz and explain call from here on. Reference them exactly.";

/** What the plan tools close over (the plan-tree half of the tool context). */
export interface PlanToolContext {
	chatId: string;
	/** The storage port plan tools persist through. */
	chatStore: ChatStore;
}

/** Plan authorship and explicit lesson-step completion, persisted on the session. */
const planCompletionInput = Type.Object({
 nodeId: Type.String({ minLength: 1 }),
 completed: Type.Boolean({ description: "True when this plan step is complete; false to reopen it." }),
 reason: Type.String({ minLength: 1, description: "Brief evidence from the lesson supporting completion or reopening." }),
});

const lessonCompletionInput = Type.Object({
	completed: Type.Boolean({ description: "True to mark the whole lesson complete; false to reopen the lesson." }),
});

const planInitInput = Type.Object({
	mermaid: Type.String({
		minLength: 1,
		description:
			"A mermaid graph block (any direction), e.g.:\ngraph TD\n  primitives[Number primitives] --> operators[Arithmetic operators] --> expressions[Evaluating expressions]\n" +
			"The only strict rule: ids are permanent lowercase slugs (a-z, 0-9, hyphens/underscores) — checks reference them via nodeId. " +
			"Titles are free single-line text; `-->` means 'from = prerequisite' (chains fine); no subgraphs, styles, or classes.",
	}),
	codingSteps: Type.Optional(Type.Array(Type.Object({
		nodeId: Type.String({ minLength: 1, maxLength: 200 }),
		goal: Type.String({ minLength: 1, maxLength: 500 }),
		mode: Type.Union([Type.Literal("problem"), Type.Literal("project")]),
		language: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
	}), { maxItems: 32, description: "Mark steps where writing code helps. Give each a focused exercise goal, Problem or Project mode (problem or project), and the actual language if known (e.g. cpp, rust, python). Omit for conceptual steps." })),
});

export function planTools(ctx: PlanToolContext): Record<string, AgentTool<any>> {
	return {
		lesson_set_completed: {
			name: "lesson_set_completed",
			label: "Update lesson status",
			description: "Mark this whole lesson complete or reopen it only when the learner explicitly requests that lesson-level change. Marking complete moves a settled, unarchived lesson to Completed in the sidebar, even with unfinished or unverified plan steps or without a plan. This changes lesson organization only: it does not complete plan steps, pass checks, or change knowledge-map mastery. For a request to complete one question or plan step, use plan_set_completed when its evidence requirements are met instead. Do not mark the whole lesson complete merely because the learner moves to the next question or pauses.",
			parameters: lessonCompletionInput,
			execute: serverExecute("lesson_set_completed", lessonCompletionInput, async ({ completed }) => {
				if (!ctx.chatStore.getChat(ctx.chatId)) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
				ctx.chatStore.setLessonCompleted(ctx.chatId, completed);
				return { ok: true, completed };
			}),
		},
        plan_set_completed: {
            name: "plan_set_completed",
            label: "Update lesson completion",
            description: "Explicitly complete or reopen a step of this session's lesson plan. Call after giving feedback when the step's learning goal has been met, including the final step. Do not count visits, skipped work, or merely asking a question as completion. Give a brief evidence-based reason. Reopen a completed step if more teaching is needed. This updates the learner's lesson-completion percentage, not their knowledge-map mastery.",
            parameters: planCompletionInput,
            execute: serverExecute("plan_set_completed", planCompletionInput, async ({ nodeId, completed, reason }) => {
                const tree = ctx.chatStore.getChat(ctx.chatId)?.tree;
                if (!tree || !tree.nodes.some(node => node.id === nodeId)) return { ok: false, error: `Unknown plan step: ${nodeId}. Use an id from the current plan.` };
                if (!reason.trim()) return { ok: false, error: "Give evidence for this completion update." };
                const ids = new Set((tree.completedNodeIds ?? []).filter(id => tree.nodes.some(node => node.id === id)));
                const changed = ids.has(nodeId) !== completed;
                if (completed) ids.add(nodeId); else ids.delete(nodeId);
                const next: PlanTree = { ...tree, completedNodeIds: [...ids], version: tree.version + (changed ? 1 : 0) };
                ctx.chatStore.saveTree(ctx.chatId, next);
                return { text: JSON.stringify({ ok: true, nodeId, completed, reason, completedNodeIds: next.completedNodeIds }), details: { ok: true, tree: next } };
            }),
        },
		plan_init: {
			name: "plan_init",
			label: "plan_init",
			description:
				"Write or REWRITE this session's plan map — the dependency graph the learner follows live in the plan window. " +
				"Call once right after the probe concludes, to present the map; re-call whenever the map is wrong (the new block replaces the old tree). " +
				"A mermaid graph block (any direction): one node per line (`slug[Short Title]` — slugs are permanent lowercase ids: a-z, 0-9, hyphens/underscores), " +
				"`-->` edges meaning 'from must be understood before to' (chains fine). 5–15 nodes: a map, not a syllabus — one reasoning step per node, compress. " +
				"Every check you fire names the node it assesses via `nodeId`; where the lesson stands derives from those tags.",
			parameters: planInitInput,
			execute: serverExecute("plan_init", planInitInput, async ({ mermaid, codingSteps }) => {
				const { chatId, chatStore } = ctx;
				const record = chatStore.getChat(chatId);
				if (!record) return { ok: false, error: `Chat not found: ${chatId}` };

				const parsed = parseMermaidPlan(mermaid);
				if (!parsed.ok || !parsed.plan) {
					// The parser collects every problem; the teacher fixes and retries.
					// No tree echo — the model needs the problems, not a restatement of
					// the map it is rewriting (owner, context diet 2026-10-09).
					return { ok: false, error: parsed.problems.join("\n") };
				}
				try {
					// createTree validates the structure (duplicate ids, missing
					// edge endpoints, self-loops, cycles → PlanTreeError).
					const marked = new Map<string, NonNullable<PlanTree["nodes"][number]["coding"]>>();
					const nodeIds = new Set(parsed.plan.nodes.map(node => node.id));
					for (const { nodeId, goal, mode, language } of codingSteps ?? []) {
						if (!nodeIds.has(nodeId) || marked.has(nodeId) || !goal.trim()) {
							throw new PlanTreeError(`Coding steps must reference unique plan node ids and include a goal. Check "${nodeId}".`);
						}
						marked.set(nodeId, { goal: goal.trim(), mode, ...(language?.trim() ? { language: language.trim().toLowerCase() } : {}) });
					}
					const nodes = parsed.plan.nodes.map(node => {
						const coding = marked.get(node.id);
						return coding ? { ...node, coding } : node;
					});
					const next = createTree(nodes, parsed.plan.edges);
					const retained = (record.tree?.completedNodeIds ?? []).filter(id => nodes.some(node => node.id === id));
                    if (retained.length) next.completedNodeIds = [...new Set(retained)];
                    chatStore.saveTree(chatId, next);
					// Context diet: content = the validated nodeIds + the reminder (the
				// ids just became binding for every quiz/explain call); details =
					// the full tree for the record/UI — the plan popup's latestTree
					// seam, agent-invisible (the serializer sends content only).
					return {
						text: JSON.stringify({
							ok: true,
							nodeIds: next.nodes.map((n) => n.id),
							reminder: PLAN_NODE_IDS_REMINDER,
						}),
						details: { ok: true, tree: next },
					};
				} catch (err) {
					if (err instanceof PlanTreeError) return { ok: false, error: err.message };
					throw err;
				}
			}),
		},
	};
}
